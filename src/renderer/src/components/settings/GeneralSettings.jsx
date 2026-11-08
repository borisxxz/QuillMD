import { LANGS } from '../../i18n.jsx'
import Toggle from '../ui/Toggle.jsx'
import SaveRecoverySettings from './SaveRecoverySettings.jsx'

export default function GeneralSettings({ lang, setLang, settings, onUpdateSettings, syncAutoSave = false, offlineReady = true, t }) {
  const closeToTray = settings.closeToTray === true
  const supportsTray = window.api?.capabilities?.closeToTray === true
  const supportsOffline = typeof window.api?.setOfflineMode === 'function'

  return (
    <>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.language')}</h2>
        <div className="settings-langs">
          {LANGS.map((l) => (
            <button key={l.id} className={`settings-lang${l.id === lang ? ' active' : ''}`} onClick={() => setLang(l.id)}>
              {l.label}
            </button>
          ))}
        </div>
      </section>
      <section className="settings-block">
        <h2 className="settings-block-title">{t('settings.startup')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.restoreSession')}</div>
            <div className="settings-row-desc">{t('settings.restoreSessionDesc')}</div>
          </div>
          <Toggle
            checked={settings.restoreSession !== false}
            onChange={(restoreSession) => onUpdateSettings({ restoreSession })}
            label={t('settings.restoreSession')}
          />
        </div>
      </section>
      <SaveRecoverySettings settings={settings} onUpdateSettings={onUpdateSettings} syncAutoSave={syncAutoSave} t={t} />
      {supportsOffline && (
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.network')}</h2>
        <div className="settings-row">
          <div className="settings-row-text">
            <div className="settings-row-label">{t('settings.offlineMode')}</div>
            <div className="settings-row-desc">{t('settings.offlineModeDesc')}</div>
          </div>
          <Toggle
            checked={settings.offlineMode === true}
            onChange={(offlineMode) => onUpdateSettings({ offlineMode })}
            label={t('settings.offlineMode')}
            disabled={!offlineReady}
          />
        </div>
      </section>
      )}
      {supportsTray && (
        <section className="settings-block">
          <h2 className="settings-block-title">{t('settings.window')}</h2>
          <div className="settings-row">
            <div className="settings-row-text">
              <div className="settings-row-label">{t('settings.closeToTray')}</div>
              <div className="settings-row-desc">{t('settings.closeToTrayDesc')}</div>
            </div>
            <Toggle
              checked={closeToTray}
              onChange={(value) => onUpdateSettings({ closeToTray: value })}
              label={t('settings.closeToTray')}
            />
          </div>
        </section>
      )}
    </>
  )
}
