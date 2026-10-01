import React, { useLayoutEffect, useRef } from 'react';
import { AlertBanner, Badge, Button, Caption, Card, Checkbox, EmptyState, Heading, Label, StatusBadge, TextInput } from './halaska-kit.jsx';
import { KitCheckbox } from './kit-controls.jsx';
import { CloudConnectionField } from './cloud-surfaces.jsx';
import { Database, FolderInput, KeyRound, Server } from 'lucide-react';
import styles from './cloud-maintenance-surfaces.css';

if (!document.getElementById('cloud-maintenance-styles')) {
  const style = document.createElement('style'); style.id = 'cloud-maintenance-styles';
  style.textContent = styles; document.head.append(style);
}
const t = (zh, en) => /^en(?:-|$)/i.test(document.documentElement.lang || '') ? en : zh;
const cardStyle = { background: 'var(--panel)', border: '1px solid var(--line)', boxShadow: 'none', borderRadius: 18 };
function SectionHeading({ icon: Icon, title, description, aside }) {
  return <div className="cloud-maintenance-heading"><span className="cloud-maintenance-icon"><Icon size={17} aria-hidden="true" /></span><div><Heading level={3}>{title}</Heading>{description && <p>{description}</p>}</div>{aside && <div className="cloud-maintenance-heading-aside">{aside}</div>}</div>;
}
function StorageStatus({ draft, onRefresh, onReconcile }) {
  const job = draft.job, uncertain = !!draft.uncertain || job?.state === 'uncertain', running = job?.state === 'running' && !uncertain;
  const labels = { running: t('正在迁移', 'Moving storage'), completed: t('迁移已完成', 'Storage moved'), error: t('迁移未完成', 'Move incomplete'), failed: t('迁移未完成', 'Move incomplete') };
  const currentFeedback = draft.message && draft.message !== job?.message;
  const title = uncertain ? t('迁移状态待确认', 'Check the move status') : currentFeedback ? (draft.kind === 'error' ? t('操作未完成', 'Operation incomplete') : t('连接状态', 'Connection status')) : labels[job?.state];
  const message = String(draft.message || job?.message || '');
  const error = uncertain || draft.kind === 'error' || (!currentFeedback && ['error', 'failed'].includes(job?.state));
  if (!message && !title && !draft.busy) return null;
  return <div id="cloudSSHMessage" className="cloud-maintenance-status" role="status" aria-live="polite" aria-atomic="true" data-state={uncertain ? 'uncertain' : job?.state || draft.kind || 'info'}>
    {error ? <AlertBanner variant="warning" title={title || t('操作未完成', 'Operation incomplete')} description={message} /> : <div className="cloud-maintenance-status-copy"><StatusBadge status={running || draft.busy ? 'accent' : draft.kind === 'success' || job?.state === 'completed' ? 'online' : 'pending'} pulse={running}>{title || (draft.busy ? t('正在核对服务器', 'Checking the server') : t('连接状态', 'Connection status'))}</StatusBadge>{message && <p>{message}</p>}</div>}
    {uncertain && <p className="cloud-maintenance-help">{t('迁移可能仍在服务器进行。本机记录会跨退出保留；核对服务器回执后再继续，不会自动重做。', 'The move may still be running on the server. Its local record survives restart. Verify the server receipt before continuing; the move will not be repeated automatically.')}</p>}
    {job && <dl className="cloud-maintenance-paths cloud-maintenance-receipt">
      {job.config?.target && <div><dt>{t('本次服务器', 'Server for this move')}</dt><dd data-user-content>{job.config.target}</dd></div>}
      {job.source && <div><dt>{t('原目录', 'Original directory')}</dt><dd data-user-content>{job.source}</dd></div>}
      {job.destination && <div><dt>{t('目标目录', 'Destination')}</dt><dd data-user-content>{job.destination}</dd></div>}
      {job.id && <div><dt>{t('迁移编号', 'Move ID')}</dt><dd data-user-content title={job.id}>{job.id}</dd></div>}
    </dl>}
    {(job || uncertain) && <div className="cloud-maintenance-actions">
      {(uncertain || running) && /^[a-f0-9]{32}$/.test(job?.id || '') && <Button id="cloudSSHReconcile" size="sm" variant="accent" disabled={!!draft.busy} onClick={onReconcile}>{draft.busy === 'reconcile' ? t('正在核对…', 'Verifying…') : t('核对服务器上的迁移结果', 'Verify the server’s move result')}</Button>}
      <Button id="cloudSSHRefresh" size="sm" variant="secondary" disabled={!!draft.busy} onClick={onRefresh}>{draft.busy === 'poll' ? t('正在读取…', 'Reading…') : t('重新读取本机状态', 'Read local status again')}</Button>
    </div>}
  </div>;
}

export function CloudSSHStorage({ draft = {}, onChange, onInspect, onSave, onMove, onRefresh, onReconcile, onConnect }) {
  const config = draft.config, remote = draft.remote, locked = !!draft.busy || ['running','uncertain'].includes(draft.job?.state) || !!draft.uncertain;
  if (!config) return <section className="cloud-maintenance-kit"><StorageStatus draft={draft} onRefresh={onRefresh} onReconcile={onReconcile} /><EmptyState icon={<Server size={24} aria-hidden="true" />} title={t('尚无可用的 SSH 配置', 'No SSH configuration available')} description={locked ? t('先核对已有迁移记录；连接配置缺失不会取消已经提交的操作。', 'Check the existing move record first. Missing connection settings do not cancel a submitted operation.') : t('连接已有的 AI Bro 同步服务后，可以在这里核对连接、查看存储位置或迁移数据目录。', 'After connecting an existing AI Bro sync service, review the connection and storage location here.')} action={<Button id="cloudSSHStorageConnect" size="sm" variant="accent" disabled={locked} onClick={onConnect}>{t('连接 SSH 服务器', 'Connect SSH server')}</Button>} /></section>;
  const destination = String(draft.destination || '').trim();
  const canMove = !locked && !!draft.verified && !!draft.confirmed && destination.startsWith('/') && destination !== remote?.dataPath;
  const fields = [
    ['target', t('SSH 主机别名 / 用户名@主机', 'SSH host alias / user@host'), 'text', t('沿用系统 SSH 密钥与主机校验。', 'Uses your system SSH keys and host verification.')],
    ['sshPort', t('SSH 端口', 'SSH port'), 'number', t('0 表示沿用 SSH 配置中的端口。', '0 uses the port in your SSH configuration.')],
    ['localPort', t('Mac 本机转发端口', 'Local forwarding port'), 'number', t('保留现有端口，以维持当前工作区绑定。', 'Kept unchanged to preserve this workspace’s binding.')],
    ['remotePort', t('服务器服务端口', 'Server service port'), 'number', t('AI Bro 同步服务在服务器上的监听端口。', 'The AI Bro sync service’s listening port on the server.')],
  ];
  return <section className="cloud-maintenance-kit" aria-busy={!!draft.busy || draft.job?.state === 'running' || undefined}>
    <StorageStatus draft={draft} onRefresh={onRefresh} onReconcile={onReconcile} />
    <Card padding={0} style={cardStyle}><SectionHeading icon={Server} title={t('服务器连接', 'Server connection')} description={t('读取路径会核对连接；修改主机后，先保存并重新连接。', 'Read the path to verify the connection. Save and reconnect after changing the host.')} aside={<Badge><span data-user-content style={{textTransform:'none'}}>{draft.savedConfig?.target || config.target}</span></Badge>} />
      <div className="cloud-maintenance-body"><div className="cloud-maintenance-fields">{fields.map(([key, label, type, caption]) => <CloudConnectionField key={key} id={'cloudSSH-' + key} label={label} caption={caption} type={type} value={config[key] == null ? '' : String(config[key])} disabled={locked} readOnly={key === 'localPort'} min={key === 'sshPort' ? 0 : type === 'number' ? 1 : undefined} max={type === 'number' ? 65535 : undefined} attributes={{ autoComplete: 'off', spellCheck: false }} onChange={value => onChange?.(key, value)} />)}</div>
        <div className="cloud-maintenance-actions"><Button id="cloudSSHInspect" size="sm" variant="secondary" disabled={locked} onClick={onInspect}>{draft.busy === 'inspect' ? t('正在读取…', 'Reading…') : t('读取服务器路径', 'Read server paths')}</Button><Button id="cloudSSHSave" size="sm" variant="outline" disabled={locked} onClick={onSave}>{draft.busy === 'save' ? t('正在重新连接…', 'Reconnecting…') : t('保存并重新连接', 'Save and reconnect')}</Button></div>
      </div>
    </Card>
    <Card padding={0} style={cardStyle}><SectionHeading icon={Database} title={t('当前存储位置', 'Current storage location')} aside={<StatusBadge status={draft.verified ? 'online' : 'pending'}>{draft.verified ? t('已核对', 'Verified') : t('待核对', 'Check needed')}</StatusBadge>} />
      <div className="cloud-maintenance-body"><dl className="cloud-maintenance-paths"><div><dt>{t('数据目录', 'Data directory')}</dt><dd>{remote?.dataPath || t('尚未读取服务器路径', 'Server path not read yet')}</dd></div>{remote?.databasePath && <div><dt>{t('数据库', 'Database')}</dt><dd>{remote.databasePath}</dd></div>}</dl>
        {!draft.verified && <p className="cloud-maintenance-help">{t('迁移前请读取并核对当前服务器路径。连接发生修改后，需要重新保存和核对。', 'Read and verify the current server path before moving storage. Save and verify again after connection changes.')}</p>}
      </div>
    </Card>
    <Card padding={0} style={cardStyle}><SectionHeading icon={FolderInput} title={t('迁移数据目录', 'Move the data directory')} description={t('复制到新位置并完成校验后，切换同步服务使用的目录。', 'Copy and verify the data, then switch the sync service to the new directory.')} />
      <div className="cloud-maintenance-body"><CloudConnectionField id="cloudSSHDataPath" label={t('新的服务器数据目录', 'New server data directory')} caption={t('填写以 / 开头的新目录，不能与当前数据目录相同。', 'Enter a new absolute path starting with /, different from the current data directory.')} value={draft.destination || ''} disabled={locked} placeholder="/home/user/aibro-data" attributes={{ autoComplete: 'off', spellCheck: false }} onChange={value => onChange?.('destination', value)} />
        <div className="cloud-maintenance-consent"><KitCheckbox id="cloudSSHMoveConfirmed" checked={!!draft.confirmed} disabled={locked} label={t('我确认短暂停止云服务，复制并校验后切换目录；保留旧目录。', 'I confirm the brief service stop, copying, verification and directory switch. The old directory will be kept.')} description={t('迁移期间请暂停其他设备上的编辑，完成后再继续同步。', 'Pause editing on other devices during the move, then resume syncing after completion.')} onChange={value => onChange?.('confirmed', value)} /></div>
        <div className="cloud-maintenance-actions"><Button id="cloudSSHMove" size="sm" variant="accent" disabled={!canMove} onClick={onMove}>{draft.busy === 'move' || draft.job?.state === 'running' ? t('迁移进行中…', 'Moving…') : t('复制校验并切换目录', 'Copy, verify and switch directories')}</Button></div>
      </div>
    </Card>
  </section>;
}

// The controller retains the original nodes, event listeners, password and form.
// React owns only the Kit presentation and never reads native field values.
function HostSlot({ id, attach, className = '', label, descriptionId }) {
  const ref = useRef(null);
  useLayoutEffect(() => attach?.(id, ref.current), [attach, id]);
  useLayoutEffect(() => {
    const control = ref.current?.querySelector('input,button');
    if (control && label) control.setAttribute('aria-label', label);
    if (control && descriptionId) control.setAttribute('aria-describedby', descriptionId);
  }, [label, descriptionId]);
  return <div ref={ref} className={`cloud-account-slot ${className}`} data-cloud-account-slot={id} />;
}
function RetainedField({ id, label, description, controls, attach, secret = false, extraDescriptionId }) {
  const state = controls[id] || {}, ref = useRef(null), descriptionId = [description ? `${id}-description` : '', extraDescriptionId || ''].filter(Boolean).join(' ');
  useLayoutEffect(() => {
    const labelNode = ref.current?.querySelector('.cloud-account-label label'); if (labelNode) labelNode.htmlFor = id;
    for (const node of ref.current?.querySelectorAll('.cloud-account-presentation input') || []) node.tabIndex = -1;
  });
  return <div className="cloud-account-field" hidden={state.hidden} ref={ref}><div className="cloud-account-label"><Label>{label}</Label></div>
    <div className="cloud-account-retained-control" data-disabled={state.disabled || undefined} data-readonly={state.readOnly || undefined}><div className="cloud-account-presentation" aria-hidden="true" inert={true}><TextInput value="" type={secret ? 'password' : 'text'} disabled={state.disabled} size="md" /></div><HostSlot id={id} attach={attach} label={label} descriptionId={descriptionId} className="cloud-account-native-control" /></div>
    {description && <p id={`${id}-description`} className="cloud-maintenance-help">{description}</p>}
  </div>;
}
function RetainedAction({ id, controls, attach, variant = 'outline' }) {
  const state = controls[id] || {}, ref = useRef(null);
  useLayoutEffect(() => { for (const node of ref.current?.querySelectorAll('.cloud-account-presentation button') || []) node.tabIndex = -1; });
  return <div ref={ref} className="cloud-account-retained-action" hidden={state.hidden} data-disabled={state.disabled || undefined}><div className="cloud-account-presentation" aria-hidden="true" inert={true}><Button size="sm" variant={variant} disabled={state.disabled}>{state.label || t('连接', 'Connect')}</Button></div><HostSlot id={id} attach={attach} className="cloud-account-native-action" /></div>;
}
function RetainedConsent({ controls, attach }) {
  const state = controls.cloudMergeConfirmed || {}, label = state.label || t('我确认合并本机与云端内容；发生冲突时由我选择保留的版本。', 'I confirm merging local and cloud content and choosing which version to keep if a conflict occurs.');
  return <div className="cloud-account-retained-consent" hidden={state.hidden} data-disabled={state.disabled || undefined}><div className="cloud-account-presentation" aria-hidden="true" inert={true}><Checkbox checked={!!state.checked} disabled={state.disabled} label={label} /></div><HostSlot id="cloudMergeConfirmed" attach={attach} label={label} className="cloud-account-native-consent" /></div>;
}
export function CloudAccountConnection({ view = {}, controls = {}, attach, onSSH }) {
  const props = { controls, attach }, retainedSSH = !!controls.cloudConnectionSSH && !controls.cloudConnectionSSH.hidden;
  return <section className="cloud-account-kit"><Card padding={0} style={cardStyle}>
    <SectionHeading icon={KeyRound} title={view.needsSignIn ? t('恢复同步账号连接', 'Reconnect your sync account') : t('使用同步服务账号', 'Use a sync service account')} description={t('这里填写 AI Bro 同步服务提供的账号；它与 SSH 登录用户、Mac 登录密码和模型 API Key 各自独立。', 'Use an account provided by the AI Bro sync service. It is separate from your SSH user, Mac password and model API key.')} aside={<Badge>HTTPS</Badge>} />
    <div className="cloud-maintenance-body"><div className="cloud-account-ssh-option"><Caption>{t('连接自己的服务器，可以使用 SSH 主机配置。', 'For your own server, you can use an SSH host configuration.')}</Caption>{!retainedSSH && onSSH && <Button id="cloudAccountUseSSH" size="sm" variant="ghost" disabled={!!controls.cloudConnect?.disabled && !!controls.cloudPassword?.disabled} onClick={onSSH}>{t('改用 SSH 连接', 'Use SSH instead')}</Button>}<RetainedAction {...props} id="cloudConnectionSSH" /></div>
      <HostSlot id="cloudConnectionIntro" attach={attach} className="cloud-account-intro" />
      <div className="cloud-maintenance-fields"><RetainedField {...props} id="cloudServerUrl" label={t('同步服务地址', 'Sync service address')} extraDescriptionId="cloudServerHint" /><RetainedField {...props} id="cloudUsername" label={t('同步账号用户名', 'Sync account username')} description={t('由该同步服务提供，不是 SSH 主机用户名。', 'Provided by the sync service, not the SSH host user.')} /><RetainedField {...props} id="cloudPassword" label={t('同步账号密码', 'Sync account password')} secret description={t('仅用于本次连接，不是 Mac 登录密码。', 'Used only for this connection, not your Mac login password.')} /><RetainedField {...props} id="cloudDeviceName" label={t('本机设备名称', 'This device’s name')} description={t('用于在已连接设备中识别这台电脑。', 'Identify this computer in the connected devices list.')} /></div>
      <HostSlot id="cloudServerHint" attach={attach} className="cloud-account-hint" />
      <div className="cloud-maintenance-consent"><RetainedConsent {...props} /></div>
      <div className="cloud-maintenance-actions"><RetainedAction {...props} id="cloudConnect" variant="accent" /></div>
    </div>
  </Card></section>;
}
