// Copy the release assets that GitHub Actions just built into the CNB
// repository's Release. GitHub remains the build source; CNB is the mirror
// used by users who cannot reach GitHub directly.
//
// Required environment:
//   GH_TOKEN     — GitHub token (the workflow's GITHUB_TOKEN is enough)
//   CNB_TOKEN    — CNB access token with repo-release:rw
// Optional:
//   CNB_REPO     — default boris007/QuillMD
//   GITHUB_REPOSITORY, GITHUB_REF_NAME — provided by Actions

const GH_TOKEN = process.env.GH_TOKEN || ''
const CNB_TOKEN = process.env.CNB_TOKEN || ''
const CNB_REPO = process.env.CNB_REPO || 'boris007/QuillMD'
const GITHUB_REPO = process.env.GITHUB_REPOSITORY || 'borisxxz/QuillMD'
const TAG = process.env.RELEASE_TAG || process.env.GITHUB_REF_NAME || String(process.env.GITHUB_REF || '').replace(/^refs\/tags\//, '')
const CNB_API = process.env.CNB_API || 'https://api.cnb.cool'

if (!GH_TOKEN) throw new Error('GH_TOKEN is required')
if (!CNB_TOKEN) throw new Error('CNB_TOKEN is required (configure it as a GitHub Actions secret)')
if (!TAG) throw new Error('release tag is missing')

const ghHeaders = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'User-Agent': 'QuillMD-release-mirror',
}
const cnbHeaders = {
  Authorization: `Bearer ${CNB_TOKEN}`,
  Accept: 'application/vnd.cnb.api+json',
  'User-Agent': 'QuillMD-release-mirror',
}

async function json(url, init) {
  const response = await fetch(url, init)
  const text = await response.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${url} -> ${response.status}: ${text.slice(0, 500)}`)
  return data
}

async function main() {
  // The tag endpoint does not return draft releases, and the workflow runs
  // while the GitHub release is still draft. List releases instead and pick
  // the tag; the Actions token can see drafts in its own repository.
  const ghReleases = await json(`https://api.github.com/repos/${GITHUB_REPO}/releases?per_page=100`, {
    headers: ghHeaders,
  })
  const release = (Array.isArray(ghReleases) ? ghReleases : []).find((item) => item.tag_name === TAG)
  if (!release) throw new Error(`GitHub release ${TAG} was not found (draft included)`)
  const assets = Array.isArray(release.assets) ? release.assets : []
  if (!assets.length) throw new Error(`GitHub release ${TAG} has no assets`)
  const only = String(process.env.CNB_SYNC_ASSETS || '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  const selected = only.length ? assets.filter((asset) => only.includes(asset.name)) : assets
  if (!selected.length) throw new Error(`no selected release assets matched CNB_SYNC_ASSETS=${only.join(',')}`)

  const list = await json(`${CNB_API}/${CNB_REPO}/-/releases`, { headers: cnbHeaders })
  let cnbRelease = (Array.isArray(list) ? list : []).find((item) => item.tag_name === TAG)
  if (!cnbRelease) {
    cnbRelease = await json(`${CNB_API}/${CNB_REPO}/-/releases`, {
      method: 'POST',
      headers: { ...cnbHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        name: release.name || `QuillMD ${TAG.replace(/^v/, '')}`,
        body: release.body || '',
        draft: false,
        prerelease: Boolean(release.prerelease),
        make_latest: 'true',
      }),
    })
  }

  const releaseId = cnbRelease.id
  const existing = new Set((cnbRelease.assets || []).map((asset) => asset.name))
  // A broken asset can keep its name across a rebuild (the v0.0.3 NSIS fix).
  // CNB_FORCE_SYNC=1 re-uploads every selected GitHub asset instead of only new names.
  const force = process.env.CNB_FORCE_SYNC === '1'
  const missing = force ? selected : selected.filter((asset) => !existing.has(asset.name))
  console.log(`CNB release ${TAG}: ${existing.size}/${assets.length} assets present; transferring ${missing.length}${force ? ' (forced replacement)' : ''}`)
  console.log(`selected: ${selected.map((asset) => asset.name).join(', ')}`)

  for (const [index, asset] of missing.entries()) {
    const expectedSize = Number(asset.size) || 0
    console.log(`[${index + 1}/${missing.length}] ${asset.name} (${(expectedSize / 1024 / 1024).toFixed(1)} MB)`)
    // Draft-release browser URLs are untagged and require authenticated API
    // access. Use the asset API URL with an octet-stream Accept; GitHub
    // redirects to the signed object URL.
    const download = await fetch(asset.url, {
      headers: {
        Authorization: `Bearer ${GH_TOKEN}`,
        Accept: 'application/octet-stream',
        'User-Agent': 'QuillMD-release-mirror',
      },
    })
    if (!download.ok) throw new Error(`download ${asset.name} -> HTTP ${download.status}`)
    const bytes = Buffer.from(await download.arrayBuffer())
    if (expectedSize && bytes.length !== expectedSize) {
      throw new Error(`size mismatch for ${asset.name}: ${bytes.length} != ${expectedSize}`)
    }

    const upload = await json(`${CNB_API}/${CNB_REPO}/-/releases/${releaseId}/asset-upload-url`, {
      method: 'POST',
      headers: { ...cnbHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        asset_name: asset.name,
        size: bytes.length,
        overwrite: true,
        ttl: 0,
      }),
    })
    const put = await fetch(upload.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: bytes,
    })
    if (!put.ok) throw new Error(`upload ${asset.name} -> HTTP ${put.status}`)
    const verify = await fetch(upload.verify_url, { method: 'POST', headers: cnbHeaders })
    if (!verify.ok) throw new Error(`verify ${asset.name} -> HTTP ${verify.status}`)
    console.log(`  OK ${asset.name}`)
  }

  const final = await json(`${CNB_API}/${CNB_REPO}/-/releases/${releaseId}`, { headers: cnbHeaders })
  const finalAssets = final.assets || []
  // A targeted repair may replace only a few assets; the full count includes
  // unrelated platform assets (and a diagnostic log on GitHub).
  if (!only.length && finalAssets.length < assets.length) {
    throw new Error(`CNB has ${finalAssets.length}/${assets.length} assets after transfer`)
  }
  const finalByName = new Map(finalAssets.map((asset) => [asset.name, asset]))
  for (const asset of selected) {
    const got = finalByName.get(asset.name)
    if (!got) throw new Error(`CNB is missing ${asset.name} after transfer`)
    if (Number(got.size) !== Number(asset.size)) {
      throw new Error(`CNB size mismatch for ${asset.name}: ${got.size} != ${asset.size}`)
    }
  }
  console.log(`CNB mirror complete: ${finalAssets.length}/${assets.length} assets`)
}

main().catch((error) => {
  console.error(`CNB release mirror failed: ${error?.message || error}`)
  process.exit(1)
})
