import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { AlertBanner, Button, Card, StatusBadge, Caption, Badge, TextInput } from './halaska-kit.jsx';
import { KitCheckbox, KitSelect, KitSwitch } from './kit-controls.jsx';
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang) ? en : zh;
const labels = {sign_in_required:['待恢复连接','Reconnect needed'],local:['纯本地','Local only'],disconnected:['纯本地','Local only'],syncing:['同步中','Syncing'],synced:['已同步','Up to date'],idle:['已连接','Connected'],offline:['离线待重试','Waiting to reconnect'],paused:['已暂停','Paused'],conflict:['有冲突待处理','Review conflicts'],auth_required:['需要重新连接','Reconnect needed'],error:['同步未完成','Sync incomplete'],pending:['有更改待上传','Changes to upload']};
export function CloudSyncOverview({view,status,ssh = {},busy,blocked,deferred,editing,connecting,onConnect,onSync,onAuto,onDevices,onConflicts,onEdit,onSSH,onSSHStorage,onDisconnect,onApply}) {
  const state = busy ? 'syncing' : view.needsSignIn ? 'sign_in_required' : deferred ? 'deferred' : view.state;
  const label = state === 'deferred' ? t('有更新待应用','Updates ready') : t(...(labels[state] || labels.local));
  const caution = ['sign_in_required','offline','error','auth_required','conflict'].includes(state);
  const tips = {
    sign_in_required:ssh.matching ? t('原服务器与工作区绑定已保留。通过 SSH 重新连接，即可恢复同步。','Your server and workspace binding are retained. Reconnect over SSH to resume sync.') : t('原同步绑定仍保留。连接原服务器即可恢复，本机内容会保留。','The sync binding is retained. Reconnect to the original server to resume; local content is kept.'),
    local:t('内容保存在本机。通过 SSH 连接自己的服务器，在多台设备间同步工作区。','Your content lives on this device. Connect your own server over SSH to sync your workspace across devices.'),
    syncing:t('正在交换最新更改，你可以继续查看本机内容。','Exchanging the latest changes. Your local content remains available.'),
    synced:t('本机更改已同步。其他设备连接同一服务器与远端工作区即可继续工作。','Local changes are synced. Connect other devices to the same server and remote workspace to continue.'),
    paused:t('自动同步已暂停。可手动同步，或重新开启自动同步。','Automatic sync is paused. Sync manually or turn it back on.'),
    pending:status.autoSync ? t('本机更改已排队，后台会继续上传。','Local changes are queued for upload in the background.') : t('本机更改尚未上传，点击同步即可更新云端。','Local changes are waiting. Sync to update the cloud.'),
    offline:t('暂时无法连接服务器。本机内容可继续使用；检查连接后重试。','The server is unavailable. Keep working locally and retry after checking the connection.'),
    error:t('本次同步未完成。本机内容已保留，可查看下方原因后重试。','Sync did not finish. Local content is retained; check the details below and retry.'),
    auth_required:ssh.matching ? t('当前连接已失效。重新通过 SSH 连接原服务器即可恢复同步。','The connection expired. Reconnect to the original server over SSH to resume sync.') : t('登录已失效。重新登录原同步账号即可恢复，本机内容会保留。','Your session expired. Sign in to the same sync account to resume; local content is retained.'),
    conflict:t('同一内容在多台设备上被修改，请对比后选择保留的版本。','The same content changed on multiple devices. Compare versions and choose what to keep.'),
    deferred:t('云端更新已收到。保存当前编辑后，将更新应用到此工作区。','Cloud updates are ready. Save your current edits to apply them to this workspace.'),
    idle:t('已连接服务器，等待首次同步完成。','Server connected. Waiting for the first sync to finish.'),
  };
  const hosts = [...(ssh.config?.target ? [{target:ssh.config.target,label:ssh.config.target,saved:true}] : []), ...(ssh.hosts || []).filter(host => host.target !== ssh.config?.target)];
  return <div className="kit-cloud-overview">
    <div className="cloud-sync-heading"><h2>{t('连接与同步','Connections & sync')}</h2><span className="cloud-sync-badge kit-cloud-badge" data-state={state} role="status"><StatusBadge status={caution ? 'pending' : state==='synced' ? 'online' : state==='syncing' ? 'accent' : 'default'} pulse={state==='syncing'}>{label}</StatusBadge></span></div>
    <p className="cloud-sync-description">{ssh.pending ? t('有一项服务器目录迁移尚未确认。先查看迁移记录，再恢复同步或更改连接。','A server storage move still needs confirmation. Review its record before syncing or changing connections.') : tips[state] || tips.idle}</p>
    {ssh.pending && <section className="cloud-sync-recovery" aria-label={t('待核对的服务器迁移','Server move requiring verification')}><AlertBanner variant="warning" title={ssh.job?.state === 'running' ? t('服务器目录迁移进行中','Server storage move in progress') : t('服务器迁移待核对','Verify the server move')} description={ssh.job?.message || t('上次操作的结果尚未确认，本机内容已保留。','The previous operation’s result is not confirmed. Local content is retained.')} /><Button id="cloudSSHResumeMaintenance" size="sm" variant="accent" disabled={busy} onClick={onSSHStorage}>{t('查看迁移并核对结果','Review and verify the move')}</Button></section>}
    <div className="kit-cloud-locations">
      <Card padding={16}><div className="kit-cloud-location-label">{t('当前设备','This device')}</div><strong data-user-content>{status.device?.name || t('本机工作区','Local workspace')}</strong><Caption>{t('内容可离线使用','Available offline')}</Caption></Card>
      <div className="kit-cloud-route" aria-hidden="true">⇄</div>
      <Card padding={16}><div className="kit-cloud-location-label">{t('同步服务器','Sync server')}</div><strong data-user-content>{ssh.matching ? ssh.config.target : status.serverUrl || status.target?.serverUrl || t('尚未连接','Not connected')}</strong><Caption><span data-user-content>{status.account?.username ? t(`远端工作区 · ${status.account.username}`,`Remote workspace · ${status.account.username}`) : ssh.matching ? t('SSH · 保留原工作区绑定','SSH · Original workspace retained') : t('选择服务器后连接工作区','Choose a server to connect a workspace')}</span></Caption></Card>
    </div>
    {(view.connected || view.needsSignIn) && <div className="cloud-sync-metrics"><span>{view.pending == null ? t('待上传数量尚未确认','Upload count unavailable') : t(`待上传 ${view.pending} 项`,`${view.pending} changes to upload`)}</span><span>{t('最后同步：','Last synced: ')}{view.lastSync === '尚未成功同步' ? t('本次启动尚未成功同步','No successful sync this session') : view.lastSync}</span></div>}
    <section className="kit-cloud-ssh-list" aria-labelledby="cloudSSHHeading">
      <div className="kit-cloud-section-heading"><h3 id="cloudSSHHeading">{t('SSH 服务器','SSH servers')}</h3><Button id="cloudSSHConnect" variant={hosts.length ? 'ghost' : 'accent'} size="sm" disabled={blocked} onClick={event=>onSSH('',event.currentTarget)}>{t('添加服务器','Add server')}</Button></div>
      <Caption>{t('读取本机 SSH 配置，使用现有 SSH 密钥连接。服务器需已部署 AI Bro 个人同步服务。','Reads your local SSH configuration and uses existing SSH keys. The server must already run the AI Bro personal sync service.')}</Caption>
      {hosts.slice(0, 4).map(host => <Card key={host.target} padding={14}><div className="kit-cloud-ssh-row"><div className="kit-cloud-ssh-copy"><strong data-user-content>{host.label || host.target}</strong>{host.label && host.label!==host.target && <Caption><span data-user-content>{host.target}</span></Caption>}<Caption>{host.saved ? ssh.matching && view.connected ? t('当前同步连接','Current sync connection') : t('已保存的连接','Saved connection') : t('来自 ~/.ssh/config','From ~/.ssh/config')}</Caption></div><div className="kit-cloud-ssh-row-actions">{host.saved && ssh.matching && <Badge>{view.connected ? t('已连接','Connected') : t('待连接','Disconnected')}</Badge>}<Button size="sm" variant={host.saved && !view.connected ? 'accent' : 'ghost'} disabled={blocked} onClick={event=>onSSH(host.target,event.currentTarget)}>{host.saved && ssh.matching && view.connected ? t('检查','Inspect') : host.saved ? t('重新连接','Reconnect') : t('连接','Connect')}</Button></div></div></Card>)}
      {hosts.length > 4 && <Button id="cloudSSHBrowseAll" variant="ghost" size="sm" disabled={blocked} onClick={event=>onSSH('',event.currentTarget)}>{t(`浏览全部 ${hosts.length} 个 SSH 主机`, `Browse all ${hosts.length} SSH hosts`)}</Button>}
      {!hosts.length && <p className="cloud-sync-muted">{ssh.loading ? t('正在读取本机 SSH 配置…','Reading local SSH configuration…') : t('尚未发现具体主机。可直接添加主机别名或 用户名@主机。','No host aliases found. Add an alias or user@host directly.')}</p>}
      {ssh.error && <p className="cloud-sync-error" role="status">{ssh.error}</p>}
    </section>
    {view.connected && <div className="kit-cloud-auto"><KitSwitch id="cloudAutoSync" label={t('自动同步','Automatic sync')} checked={status.autoSync===true} disabled={blocked} onChange={onAuto} description={ssh.pending ? t('迁移结果核对前保持暂停。','Paused until the move result is verified.') : t('在后台同步更改；暂停后仍可手动同步。','Sync changes in the background. Manual sync stays available while paused.')} /></div>}
    <div className="cloud-sync-actions kit-cloud-main-actions">
      {view.connected && (view.state==='auth_required' ? <Button id="cloudReconnect" variant="accent" size="sm" disabled={blocked} onClick={ssh.matching ? ()=>onSSH(ssh.config.target) : onConnect}>{t('重新连接','Reconnect')}</Button> : <Button id="cloudSyncNow" variant="accent" size="sm" disabled={blocked || view.state==='syncing'} loading={busy || view.state==='syncing'} onClick={onSync}>{['offline','error'].includes(view.state)?t('重试同步','Retry sync'):t('立即同步','Sync now')}</Button>)}
      {!!view.conflicts && <Button id="cloudConflicts" size="sm" disabled={busy} onClick={onConflicts}>{t(`处理冲突 · ${view.conflicts}`,`Review conflicts · ${view.conflicts}`)}</Button>}
      {deferred && <Button id="cloudApplyReceived" size="sm" disabled={blocked} onClick={onApply}>{t('应用已收到的更新','Apply received updates')}</Button>}
      {view.connected && <Button id="cloudDevices" variant="ghost" size="sm" disabled={busy} onClick={onDevices}>{t('管理设备','Manage devices')}</Button>}
    </div>
    <details className="cloud-sync-advanced"><summary>{t('其他连接方式与高级设置','Other connections & advanced settings')}</summary>
      <p>{t('已有 HTTPS 同步服务时，可使用该服务独立的同步账号登录。它不是 SSH 用户名、Mac 登录密码或模型 API Key。','For an existing HTTPS sync service, sign in with its own sync account. This is separate from your SSH user, Mac password, and model API key.')}</p>
      <div className="cloud-sync-actions">
        <Button id="cloudStartConnect" variant="ghost" size="sm" disabled={blocked} onClick={onConnect}>{connecting?t('收起账号登录','Hide account sign-in'):t('使用同步账号登录','Sign in with sync account')}</Button>
        {view.connected && <Button id="cloudEditConnection" variant="ghost" size="sm" disabled={blocked} onClick={onEdit}>{editing?t('取消修改','Cancel changes'):t('修改登录信息','Edit sign-in details')}</Button>}
        <Button id="cloudSSHSettings" variant="ghost" size="sm" disabled={busy} onClick={onSSHStorage}>{t('SSH 高级维护与存储目录','SSH maintenance & storage')}</Button>
        {view.connected && <Button id="cloudDisconnect" variant="ghost" size="sm" disabled={busy} onClick={onDisconnect}>{t('断开连接','Disconnect')}</Button>}
      </div>
      <Caption>{t('同步项目、对话、知识、任务和资料；模型凭据与本机项目目录留在各设备。断开后，本机资料仍保留。','Sync projects, conversations, knowledge, tasks, and sources. Model credentials and local project paths stay on each device. Disconnecting keeps local content.')}</Caption>
    </details>
  </div>;
}

// The Kit input keeps its visual structure while this small adapter supplies
// semantic IDs, constraints and an IME draft for the DOM-owned cloud controller.
export function CloudConnectionField({ id, value = '', onChange, label, caption, placeholder, disabled = false, readOnly = false, type = 'text', maxLength, min, max, attributes = {}, onKeyDown, onFocus, onBlur }) {
  const generated = useId(), fieldId = id || `cloud-field-${generated}`, ref = useRef(null), composing = useRef(false), sent = useRef(String(value)), previousAttributes = useRef([]);
  const [draft, setDraft] = useState(String(value));
  useLayoutEffect(() => { if (!composing.current) { setDraft(String(value)); sent.current = String(value); } }, [value]);
  const submit = next => { if (!disabled && !readOnly && next !== sent.current) { sent.current = next; onChange?.(next); } };
  useLayoutEffect(() => {
    const input = ref.current?.querySelector('input'); if (!input) return;
    input.id = fieldId; input.readOnly = readOnly; input.autocomplete = 'off';
    input.setAttribute('aria-label', label || '');
    for (const [name, value] of Object.entries({ maxlength: maxLength, min, max })) { if (value == null) input.removeAttribute(name); else input.setAttribute(name, String(value)); }
    for (const name of previousAttributes.current) input.removeAttribute(name);
    previousAttributes.current = Object.keys(attributes).filter(name => /^(aria-|data-)/.test(name) || ['role', 'name', 'title', 'inputmode'].includes(name));
    for (const name of previousAttributes.current) { if (attributes[name] != null) input.setAttribute(name, String(attributes[name])); }
    const describedBy = [attributes['aria-describedby'], caption ? `${fieldId}-caption` : null].filter(Boolean).join(' ');
    if (describedBy) input.setAttribute('aria-describedby', describedBy); else input.removeAttribute('aria-describedby');
    const nativeLabel = ref.current.querySelector('label'); if (nativeLabel) nativeLabel.htmlFor = fieldId;
    const start = () => { composing.current = true; };
    const end = event => { composing.current = false; const next = event.target.value; setDraft(next); submit(next); };
    input.addEventListener('compositionstart', start); input.addEventListener('compositionend', end);
    return () => { input.removeEventListener('compositionstart', start); input.removeEventListener('compositionend', end); };
  });
  return <div ref={ref} className="kit-cloud-field" data-readonly={readOnly || undefined} onFocus={onFocus} onBlur={onBlur} onKeyDown={event => { if (!composing.current && !event.nativeEvent?.isComposing && event.keyCode !== 229) onKeyDown?.(event); }}>
    <TextInput value={draft} label={label} placeholder={placeholder} disabled={disabled} type={type} size="md" onChange={next => { if (disabled || readOnly) return; setDraft(next); if (!composing.current) submit(next); }} />
    {caption && <div id={`${fieldId}-caption`} className="kit-cloud-field-caption"><Caption>{caption}</Caption></div>}
  </div>;
}

// An editable combobox accepts an arbitrary SSH alias/user@host as well as the
// discovered config. Only an explicit option click/Enter selects a suggestion.
export function CloudSSHHostPicker({ value = '', hosts = [], disabled = false, onChange }) {
  const [open, setOpen] = useState(false), [active, setActive] = useState(-1), ref = useRef(null);
  const options = hosts.filter((host, index, all) => host.target && all.findIndex(item => item.target === host.target) === index);
  const query = String(value).trim().toLocaleLowerCase();
  const filtered = options.filter(host => `${host.target} ${host.label || ''}`.toLocaleLowerCase().includes(query));
  const expanded = open && !disabled;
  const selected = active >= 0 && active < filtered.length ? filtered[active] : null;
  useLayoutEffect(() => { if (disabled) { setOpen(false); setActive(-1); } }, [disabled]);
  useLayoutEffect(() => { if (expanded && selected) ref.current?.querySelector(`#cloudSSHHostOption-${active}`)?.scrollIntoView?.({ block: 'nearest' }); }, [active, expanded, selected?.target]);
  const choose = host => { if (disabled) return; onChange?.(host.target); setOpen(false); setActive(-1); ref.current?.querySelector('input')?.focus({ preventScroll: true }); };
  const keyDown = event => {
    if (disabled) return;
    if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setOpen(false); setActive(-1); }
    else if (['ArrowDown', 'ArrowUp'].includes(event.key) && filtered.length) { event.preventDefault(); setOpen(true); setActive(index => event.key === 'ArrowDown' ? (index + 1) % filtered.length : index < 0 ? filtered.length - 1 : (index + filtered.length - 1) % filtered.length); }
    else if (event.key === 'Enter' && expanded) { event.preventDefault(); event.stopPropagation(); if (selected) choose(selected); else setOpen(false); }
  };
  return <div ref={ref} className="kit-cloud-host-picker" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); } }}>
    <div className="kit-cloud-host-control">
    <CloudConnectionField id="cloudSSHHost" label={t('SSH 主机', 'SSH host')} value={value} disabled={disabled} placeholder={t('搜索主机，或输入 用户名@主机', 'Search hosts, or enter user@host')} onChange={next => { setActive(-1); setOpen(true); onChange?.(next); }} onFocus={() => { if (!disabled) { setOpen(true); setActive(-1); } }} onKeyDown={keyDown}
      attributes={{ role: 'combobox', 'aria-autocomplete': 'list', 'aria-expanded': expanded, 'aria-controls': expanded ? 'cloudSSHHostSuggestions' : null, 'aria-activedescendant': expanded && selected ? `cloudSSHHostOption-${active}` : null, 'aria-describedby': 'cloudSSHHostHelp' }} />
    {expanded && <div className="kit-cloud-host-popover" onMouseDown={event => event.preventDefault()}><Card padding={6}>
      <div id="cloudSSHHostSuggestions" role="listbox" aria-label={t('SSH 主机建议', 'SSH host suggestions')} className="kit-cloud-host-options">
        {filtered.map((host, index) => <div key={host.target} id={`cloudSSHHostOption-${index}`} role="option" aria-selected={index === active} data-active={index === active || undefined} className="kit-cloud-host-option" onMouseEnter={() => setActive(index)}><Button id={`cloudSSHHostChoose-${index}`} variant="ghost" size="sm" tabIndex={-1} disabled={disabled} onClick={() => choose(host)}><span className="kit-cloud-host-option-copy"><span data-user-content>{host.label || host.target}</span>{host.label && host.label !== host.target && <small data-user-content>{host.target}</small>}</span></Button></div>)}
      </div>
      {!filtered.length && <div className="kit-cloud-host-empty">{query ? t('未找到已配置主机。可以直接检查当前输入的地址。', 'No configured host matches. Check the address you entered directly.') : t('尚未发现 SSH 主机。输入主机别名或 用户名@主机。', 'No SSH hosts found. Enter an alias or user@host.')}</div>}
    </Card></div>}
    </div>
    <div id="cloudSSHHostHelp" className="kit-cloud-field-help">{t('来自本机 SSH 配置；也可直接输入新地址。↑ ↓ 选择，Enter 确认。', 'Uses local SSH configuration; new addresses are accepted. Use ↑ ↓ to select, Enter to confirm.')}</div>
  </div>;
}

export function CloudSSHConnection({ draft, hosts = [], boundAccountId, boundServer, onChange, onProbe, onConnect }) {
  const processing = !!draft.busy, remote = draft.probe, accounts = remote?.accounts || [], allowed = boundAccountId ? accounts.filter(account => account.id === boundAccountId) : accounts;
  const pausedRecovery = !!boundAccountId && draft.autoSync === false;
  const canConnect = !!remote?.active && !!draft.accountId && allowed.some(account => account.id === draft.accountId) && !!draft.deviceName.trim() && draft.confirmed && !processing;
  const field = (key, label, caption) => <CloudConnectionField key={key} id={`cloudSSHConnect-${key}`} type="number" value={draft.config[key]} label={label} caption={caption} disabled={processing} readOnly={key === 'localPort' && !!boundServer} min={key === 'sshPort' ? 0 : 1} max={65535} attributes={{ inputmode: 'numeric' }} onChange={value => onChange(key, value)} />;
  return <div className="kit-cloud-ssh-connection" aria-busy={processing}>
    <p className="cloud-sync-description">{t('使用系统 SSH 密钥连接自己的服务器。先检查服务，再选择远端工作区并确认同步。', 'Use your system SSH keys to connect your server. Check the service, choose a remote workspace, then confirm sync.')}</p>
    {!!boundAccountId && <div className="kit-cloud-binding"><Badge>{t('保留现有绑定', 'Existing binding retained')}</Badge><Caption>{t('本机工作区已绑定远端账号，重新连接会沿用原工作区。', 'This local workspace is bound to a remote account. Reconnecting keeps the original workspace.')}</Caption></div>}
    <div className="kit-cloud-connection-fields">
      <CloudSSHHostPicker value={draft.config.target} hosts={hosts} disabled={processing} onChange={value => onChange('target', value)} />
      <CloudConnectionField id="cloudSSHDeviceName" label={t('本机设备名称', 'This device name')} value={draft.deviceName} disabled={processing} maxLength={100} caption={t('用于在同步设备列表中识别这台电脑。', 'Identifies this computer in the synced devices list.')} onChange={value => onChange('deviceName', value)} />
    </div>
    <details className="cloud-sync-advanced"><summary>{t('端口与连接方式', 'Ports & connection details')}</summary><div className="kit-cloud-connection-fields kit-cloud-port-fields">
      {field('sshPort', t('SSH 端口', 'SSH port'), t('0 表示沿用本机 SSH 配置', '0 uses local SSH configuration'))}
      {field('remotePort', t('服务器同步端口', 'Server sync port'))}
      {field('localPort', t('本机转发端口', 'Local forwarding port'), boundServer ? t('当前绑定已使用此端口，重新连接时保持不变。', 'Kept unchanged because the current binding uses this port.') : undefined)}
    </div><Caption>{t('沿用系统 SSH 配置、密钥和主机指纹验证。首次连接请先在终端完成 SSH 信任确认；此处不保存服务器密码。', 'Uses system SSH configuration, keys, and host fingerprint verification. Complete first-time SSH trust in Terminal; server passwords are not stored here.')}</Caption></details>
    <div className="cloud-sync-actions"><Button id="cloudSSHProbe" size="sm" variant="secondary" loading={draft.busy === 'probe'} disabled={processing || !String(draft.config.target).trim()} onClick={onProbe}>{remote ? t('重新检查', 'Check again') : t('检查连接', 'Check connection')}</Button></div>
    {remote && <Card padding={16}><div className="kit-cloud-section-heading"><strong>{t('服务器检查结果', 'Server check')}</strong><StatusBadge status={remote.active ? 'online' : 'pending'}>{remote.active ? t('同步服务已运行', 'Sync service running') : t('同步服务未运行', 'Sync service not running')}</StatusBadge></div><dl className="kit-cloud-ssh-facts"><div><dt>{t('主机', 'Host')}</dt><dd data-user-content>{draft.config.target}</dd></div><div><dt>{t('数据目录', 'Data directory')}</dt><dd data-user-content>{remote.dataPath || t('未返回', 'Not returned')}</dd></div></dl>
      {!!allowed.length && <div className="kit-cloud-workspace-field"><label htmlFor="cloudSSHAccount">{t('远端工作区', 'Remote workspace')}</label><KitSelect id="cloudSSHAccount" value={draft.accountId} disabled={processing || !!boundAccountId} label={t('远端工作区', 'Remote workspace')} placeholder={t('请选择一个工作区', 'Choose a workspace')} options={allowed.map(account => ({ value: account.id, label: account.username || account.id }))} onChange={value => onChange('accountId', value)} attributes={{ 'aria-describedby': 'cloudSSHAccountHelp' }} /><div id="cloudSSHAccountHelp"><Caption>{boundAccountId ? t('沿用当前工作区原有的账号绑定。', 'Keeps the original account binding for this workspace.') : t('这是 AI Bro 同步服务中的工作区账号，与 SSH 登录用户名不同，无需在此输入其密码。', 'This is an AI Bro sync workspace account, separate from the SSH login username. Its password is not needed here.')}</Caption></div></div>}
    </Card>}
    <div id="cloudSSHConnectionMessage" className="kit-cloud-connection-message" role={draft.kind === 'error' ? 'alert' : 'status'} aria-live={draft.kind === 'error' ? 'assertive' : 'polite'}>{draft.message && (draft.kind === 'error' ? <AlertBanner variant="danger" title={t('连接尚未完成', 'Connection not completed')} description={draft.message} /> : <div className="kit-cloud-progress"><StatusBadge status={draft.kind === 'success' ? 'online' : processing ? 'accent' : 'default'} pulse={processing}>{draft.kind === 'success' ? t('检查通过', 'Check passed') : processing ? t('正在处理', 'Working') : t('连接提示', 'Connection details')}</StatusBadge><Caption>{draft.message}</Caption></div>)}</div>
    {remote?.active && allowed.length > 0 && <div className="kit-cloud-merge-confirmation"><KitCheckbox id="cloudSSHMergeConfirmed" checked={draft.confirmed} disabled={processing} label={pausedRecovery ? t('恢复原工作区连接，保持自动同步暂停', 'Restore the original workspace connection and keep automatic sync paused') : boundAccountId ? t('恢复原工作区连接，并继续自动同步', 'Restore the original workspace connection and continue automatic sync') : t('合并本机与所选远端工作区，并开启自动同步', 'Merge this device with the selected workspace and enable automatic sync')} description={pausedRecovery ? t('仅恢复本机设备授权，不自动上传或下载资料。准备好后可手动同步。', 'Only restores this device’s authorization. No automatic uploads or downloads; sync manually when you are ready.') : t('发生冲突时，由你选择保留的版本。确认后才会上传本机内容。', 'You choose which version to keep if conflicts arise. Local content uploads only after confirmation.')} onChange={value => onChange('confirmed', value)} /></div>}
    <div className="cloud-sync-actions"><Button id="cloudSSHConnectNow" variant="accent" loading={draft.busy === 'connect'} disabled={!canConnect} onClick={onConnect}>{pausedRecovery ? t('恢复连接', 'Restore connection') : boundAccountId ? t('恢复连接并同步', 'Restore & sync') : t('连接并同步', 'Connect & sync')}</Button></div>
    <Caption>{t('服务器需已部署 AI Bro 个人同步服务。当前连接用于同步工作区，不会自动安装服务或启动远程 Agent。', 'The server must already run the AI Bro personal sync service. This connects workspace sync; it does not install a service or launch a remote agent.')}</Caption>
  </div>;
}
