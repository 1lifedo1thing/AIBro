// A pinned upstream fix, applied in memory by the editor bundle build. Never
// mutate node_modules: upgrades must deliberately revalidate this render path.
export const CREPE_TOP_BAR_PATCH = Object.freeze({
  id: 'crepe-topbar-readonly-subscription',
  package: '@milkdown/crepe',
  version: '7.22.2',
  sourcePath: 'lib/esm/feature/top-bar/index.js',
  reason: 'Subscribe before the readonly early return so saving can restore format controls without recreating the document editor.'
});

const anchor = '    return () => {\n      const view = isReady() ? ctx.get(editorViewCtx) : null;\n      const isReadonly = view ? !view.editable : false;\n      if (isReadonly) return null;';

export function patchCrepeTopBar(source, { version } = {}) {
  if (version !== CREPE_TOP_BAR_PATCH.version) throw new Error(`Crepe TopBar patch requires ${CREPE_TOP_BAR_PATCH.version}; found ${version || 'unknown'}. Revalidate before upgrading.`);
  const count = source.split(anchor).length - 1;
  if (count !== 1) throw new Error(`Crepe TopBar patch expected one readonly render anchor; found ${count}. Revalidate upstream source.`);
  return source.replace(anchor, anchor.replace('    return () => {\n', '    return () => {\n      subscribeState();\n'));
}
