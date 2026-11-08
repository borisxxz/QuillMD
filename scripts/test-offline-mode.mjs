import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initOfflineMode, offlineBlockedUrl, offlineFetch, setOfflineMode } from '../src/main/offline.js'
import { stagePdfImages } from '../src/main/pdf-images.js'

const profile = await mkdtemp(join(tmpdir(), 'quillmd-offline-core-'))
try {
  initOfflineMode({ getPath: () => profile })
  assert.equal(setOfflineMode(true), true)
  assert.equal(offlineBlockedUrl('https://example.com/a.png'), true)
  assert.equal(offlineBlockedUrl('http://127.0.0.1:36677/upload'), true)
  assert.equal(offlineBlockedUrl('file:///D:/doc/a.png'), false)
  assert.equal(offlineBlockedUrl('data:image/png;base64,AAAA'), false)

  let fetches = 0
  const fetchImpl = async () => {
    fetches += 1
    return new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 })
  }
  const guarded = offlineFetch(fetchImpl)
  await assert.rejects(guarded('https://example.com/blocked.png'), /离线模式/)
  assert.equal(fetches, 0)

  // PDF/HTML export remote-image staging must degrade to unresolved instead of
  // connecting while offline, then stage normally once offline is off.
  const source = () => ({
    html: '<p>[[REMOTE]]</p>',
    images: [{ placeholder: '[[REMOTE]]', src: 'https://example.com/remote.png' }]
  })
  const offlineAssets = await mkdtemp(join(tmpdir(), 'quillmd-offline-assets-'))
  try {
    const blocked = await stagePdfImages(source(), {
      assetsDir: offlineAssets,
      fetchImpl: guarded
    })
    assert.equal(blocked.stagedImages, 0)
    assert.equal(blocked.unresolvedImages, 1)
    assert.equal(fetches, 0)

    setOfflineMode(false)
    const allowed = await stagePdfImages(source(), {
      assetsDir: offlineAssets,
      fetchImpl: guarded
    })
    assert.equal(allowed.stagedImages, 1)
    assert.equal(allowed.unresolvedImages, 0)
    assert.equal(fetches, 1)
  } finally {
    await rm(offlineAssets, { recursive: true, force: true })
  }
} finally {
  await rm(profile, { recursive: true, force: true })
}

console.log('offline core ok: URL gate, fetch guard, export remote-image staging')
