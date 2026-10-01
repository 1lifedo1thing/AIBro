import { createHash } from 'node:crypto';

// Local, optional host contract for the pinned MIT DataTable. Keep the vendor
// file byte-for-byte intact; both this component fingerprint and the build's
// full-source fingerprint must be reviewed when upgrading Halaska.
export const DATA_TABLE_SOURCE_SHA256 = '89fb3953fb6d5ee7f74b7ec6ff3585578cc44bb0e231519835437c10e18bb06e';
export function patchHalaskaDataTable(source) {
  const startToken = 'function DataTable({ columns, rows, theme: tp }) {', endToken = '\nfunction AlertDialog(';
  const start = source.indexOf(startToken), end = source.indexOf(endToken, start);
  if (start < 0 || end < start || source.indexOf(startToken, start + 1) !== -1 || source.indexOf(endToken, end + 1) !== -1) {
    throw new Error('Halaska DataTable patch requires unique pinned component boundaries. Revalidate upstream.');
  }
  let table = source.slice(start, end);
  if (createHash('sha256').update(table).digest('hex') !== DATA_TABLE_SOURCE_SHA256) {
    throw new Error('Halaska DataTable source changed. Revalidate the controlled-table patch.');
  }
  function replace(before, after) {
    if (!table.includes(before) || table.indexOf(before) !== table.lastIndexOf(before)) throw new Error('Halaska DataTable patch anchor is not unique: ' + before.slice(0, 70));
    table = table.replace(before, after);
  }
  replace(startToken, `function DataTable({ columns, rows, theme: tp,
  getRowId, getRowCells, selectedIds, onToggleRow, onToggleAll,
  sort: controlledSort, onSortChange, sortKeys, manualSort = false,
  renderSelection, getRowProps, columnKeys, disabled = false, tableLabel,
}) {`);
  replace('  const sortedRows = sort.key != null', `  // Host-controlled mode uses typed IDs, never a displayed row index.
  const controlled = selectedIds !== undefined;
  if (controlled && (!Array.isArray(selectedIds) || typeof getRowId !== "function" || typeof renderSelection !== "function")) throw new Error("Controlled DataTable requires selectedIds, getRowId and a native selection renderer.");
  const keys = rows.map((row, index) => getRowId ? getRowId(row, index) : index);
  if (controlled && (keys.some(key => typeof key !== "string" || !key) || new Set(keys).size !== keys.length)) throw new Error("Controlled DataTable row IDs must be unique non-empty strings.");
  const selectedKeys = controlled ? new Set(selectedIds) : selected;
  const activeSort = controlledSort || sort;
  const selectedCount = keys.filter(key => selectedKeys.has(key)).length;
  const allChecked = rows.length > 0 && selectedCount === rows.length;
  const indeterminate = selectedCount > 0 && !allChecked;
  const cellsFor = row => getRowCells ? getRowCells(row) : row;
  const keyFor = (row, index) => getRowId ? getRowId(row, index) : index;
  const sortedRows = !manualSort && sort.key != null`);
  replace(`  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((_, i) => i)));
  };
  const toggleRow = (i) => {
    const s = new Set(selected);
    s.has(i) ? s.delete(i) : s.add(i);
    setSelected(s);
  };
  const toggleSort = (i) => {
    if (sort.key === i) setSort({ key: i, dir: sort.dir === "asc" ? "desc" : "asc" });
    else setSort({ key: i, dir: "asc" });
  };`, `  const toggleAll = (checked = !allChecked) => {
    if (disabled || !rows.length) return;
    if (controlled) { onToggleAll?.(!!checked); return; }
    setSelected(checked ? new Set(keys) : new Set());
  };
  const toggleRow = (key, checked = !selectedKeys.has(key)) => {
    if (disabled) return;
    if (controlled) { onToggleRow?.(key, !!checked); return; }
    const next = new Set(selected); checked ? next.add(key) : next.delete(key); setSelected(next);
  };
  const toggleSort = key => {
    if (disabled || key == null) return;
    if (manualSort) { onSortChange?.(key); return; }
    setSort({ key, dir: sort.key === key && sort.dir === "asc" ? "desc" : "asc" });
  };`);
  replace('<table style={{ width:', '<table aria-label={tableLabel} aria-busy={disabled || undefined} style={{ width:');
  replace('<th style={{ padding: "10px 14px", width: 24 }}>\n              <Checkbox theme={theme} checked={selected.size === rows.length && rows.length > 0} onChange={toggleAll} />', `<th scope="col" data-column="selection" style={{ padding: "10px 14px", width: 24 }}>
              {renderSelection ? renderSelection({ all: true, checked: allChecked, indeterminate, disabled: disabled || !rows.length, onChange: toggleAll }) : <Checkbox theme={theme} checked={allChecked} disabled={disabled || !rows.length} onChange={toggleAll} />}`);
  replace(`            {columns.map((col, i) => (
              <th key={i} onClick={() => toggleSort(i)} style={{ ...tokens.type.xs, fontWeight: tokens.weight.semibold, color: pal.textTertiary, textAlign: "left", padding: "10px 14px", textTransform: "uppercase", letterSpacing: "0.05em", cursor: "pointer", userSelect: "none", transition: \`color \${motion.smooth} \${motion.easeInOut}\` }}>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{col}
                  {sort.key === i && <span style={{ color: pal.text }}>{sort.dir === "asc" ? "↑" : "↓"}</span>}
                </span>
              </th>
            ))}`, `            {columns.map((col, i) => {
              const sortKey = sortKeys ? sortKeys[i] : i;
              const sorted = sortKey != null && activeSort.key === sortKey;
              const label = <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{col}
                {sorted && <span aria-hidden="true" style={{ color: pal.text }}>{activeSort.dir === "asc" ? "↑" : "↓"}</span>}
              </span>;
              return <th key={columnKeys?.[i] || i} scope="col" data-column={columnKeys?.[i]}
                aria-sort={sortKey == null ? undefined : sorted ? activeSort.dir === "asc" ? "ascending" : "descending" : "none"}
                style={{ ...tokens.type.xs, fontWeight: tokens.weight.semibold, color: pal.textTertiary, textAlign: "left", padding: "10px 14px", textTransform: "uppercase", letterSpacing: "0.05em", userSelect: "none", transition: "color " + motion.smooth + " " + motion.easeInOut }}>
                {sortKey == null ? label : <button type="button" disabled={disabled} onClick={() => toggleSort(sortKey)}
                  style={{ display: "inline-flex", border: 0, padding: 0, background: "transparent", color: "inherit", font: "inherit", cursor: disabled ? "default" : "pointer" }}>{label}</button>}
              </th>;
            })}`);
  replace(`<tr key={ri} onMouseEnter={() => setHoverRow(ri)} onMouseLeave={() => setHoverRow(-1)}`, `<tr {...(getRowProps?.(row) || {})} key={keyFor(row, ri)} aria-selected={selectedKeys.has(keyFor(row, ri))}
              onMouseEnter={() => setHoverRow(keyFor(row, ri))} onMouseLeave={() => setHoverRow(-1)}`);
  replace('background: selected.has(ri) ? pal.accentBg : hoverRow === ri ? pal.bgSubtle', 'background: selectedKeys.has(keyFor(row, ri)) ? pal.accentBg : hoverRow === keyFor(row, ri) ? pal.bgSubtle');
  replace(`<td style={{ padding: "10px 14px" }}>
                <Checkbox theme={theme} checked={selected.has(ri)} onChange={() => toggleRow(ri)} />`, `<td data-column="selection" style={{ padding: "10px 14px" }}>
                {renderSelection ? renderSelection({ row, key: keyFor(row, ri), checked: selectedKeys.has(keyFor(row, ri)), indeterminate: false, disabled, onChange: checked => toggleRow(keyFor(row, ri), checked) }) : <Checkbox theme={theme} checked={selectedKeys.has(keyFor(row, ri))} disabled={disabled} onChange={checked => toggleRow(keyFor(row, ri), checked)} />}`);
  replace('{row.map((cell, ci) => (', '{cellsFor(row).map((cell, ci) => (');
  replace('<td key={ci} style={{ ...tokens.type.sm,', '<td key={columnKeys?.[ci] || ci} data-column={columnKeys?.[ci]} style={{ ...tokens.type.sm,');
  return source.slice(0, start) + table + source.slice(end);
}
