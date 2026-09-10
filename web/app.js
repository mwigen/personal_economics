const CONFIG_PATHS = [
  'config/main_categories.json',
  'config/subcategories.json',
  'config/product_overrides.json',
  'config/product_family.json',
];
const STORAGE_KEY = 'personal-economics-static-data-v1';
const OVERRIDE_STORAGE_KEY = 'personal-economics-mapping-overrides-v1';
const $ = id => document.getElementById(id);
const state = {
  rows: [],
  config: JSON.parse(JSON.stringify(window.SPENDING_CONFIG_DEFAULTS || {})),
  loadedNames: new Set(),
};
const tableSort = { key: 'spend', direction: -1 };
const selectedItems = new Set();
const pendingOverrides = new Map();
let selectionAnchorKey = null;
const money = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 0 });
const number = new Intl.NumberFormat('nb-NO', { maximumFractionDigits: 2 });

function normalized(value) { return String(value ?? '').trim().toUpperCase(); }
function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}
function isoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? String(value).slice(0, 10) : date.toISOString().slice(0, 10);
}
function remaDate(value) {
  const timestamp = numeric(value);
  return timestamp ? new Date(timestamp).toISOString().slice(0, 10) : '';
}

function configKind(data, filename = '') {
  if (filename.endsWith('main_categories.json') || data.exact_mappings) return 'main';
  if (filename.endsWith('subcategories.json')) return 'subcategories';
  if (filename.endsWith('product_overrides.json') || Object.values(data).some(v => v && typeof v === 'object' && ('main' in v || 'sub' in v))) return 'overrides';
  if (filename.endsWith('product_family.json') || data.regex_replacements) return 'family';
  return '';
}

function classifyMain(rawCategory, productName) {
  const raw = normalized(rawCategory), product = normalized(productName);
  const override = state.config.overrides?.[product];
  if (override?.main) return override.main;
  const main = state.config.main || {};
  const exact = Object.fromEntries(Object.entries(main.exact_mappings || {}).map(([key, value]) => [normalized(key), value]));
  if (exact[raw]) return exact[raw];
  const matches = (text, term, mode) => mode === 'startswith' ? text.startsWith(normalized(term)) : mode === 'word' ? new RegExp(`(^|\\W)${normalized(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=\\W|$)`).test(text) : text.includes(normalized(term));
  for (const rule of main.rules || []) if ((rule.terms || []).some(term => matches(raw, term, rule.mode))) return rule.target;
  if (['', 'UNKNOWN', 'ODA'].includes(raw)) {
    for (const rule of main.rules || []) if ((rule.terms || []).some(term => matches(product, term, rule.mode))) return rule.target;
    for (const [category, rules] of Object.entries(state.config.subcategories || {})) {
      if (rules.some(rule => (rule.terms || []).some(term => product.includes(normalized(term))))) return category;
    }
  }
  return main.default_category || 'Misc food / unclear';
}

function classifySub(main, rawCategory, productName) {
  const product = normalized(productName);
  const override = state.config.overrides?.[product];
  if (override?.sub) return override.sub;
  const combined = `${normalized(rawCategory)} ${product}`;
  for (const rule of state.config.subcategories?.[main] || []) {
    if ((rule.terms || []).some(term => combined.includes(normalized(term)))) return rule.target;
  }
  if (main === 'Health & supplements') return 'Omega-3 / supplements';
  if (main === 'Unclassified') return 'Unclassified';
  return `Other ${main.toLocaleLowerCase()}`;
}

function familyFor(productName) {
  const product = String(productName || 'Unknown item').trim();
  const override = state.config.overrides?.[normalized(product)];
  if (override?.family) return override.family;
  let family = product;
  for (const rule of state.config.family?.regex_replacements || []) {
    try { family = family.replace(new RegExp(rule.pattern, 'gi'), rule.replacement || ''); } catch { /* invalid user regex */ }
  }
  return family.replace(/\s{2,}/g, ' ').replace(/^[ ,\-]+|[ ,\-]+$/g, '') || product;
}

function canonicalRow(row) {
  const product = row.product_name ?? row.product ?? 'Unknown item';
  const raw = row.raw_category ?? row.raw ?? 'Unknown';
  const main = row.main_category ?? row.main ?? classifyMain(raw, product);
  return {
    source: String(row.source || 'Imported'),
    lineId: String(row.line_id ?? row.lineId ?? crypto.randomUUID()),
    transactionId: String(row.transaction_id ?? row.transactionId ?? ''),
    date: isoDate(row.purchase_date ?? row.date),
    merchant: String(row.merchant_name ?? row.merchant ?? ''),
    raw: String(raw), product: String(product),
    quantity: numeric(row.quantity, 1), amount: numeric(row.amount ?? row.price), discount: numeric(row.discount),
    main, sub: row.subcategory ?? row.sub ?? classifySub(main, raw, product),
    family: row.product_family ?? row.family ?? familyFor(product),
  };
}

function parseRema(data) {
  const rows = [];
  for (const [transactionIndex, transaction] of (data.TransactionsInfo?.Transactions || []).entries()) {
    const transactionId = String(transaction.Id || `transaction-${transactionIndex}`);
    for (const [lineIndex, item] of (transaction.Receipt || []).entries()) rows.push(canonicalRow({
      source: 'REMA 1000', line_id: `${transactionId}:${lineIndex}`, transaction_id: transactionId,
      purchase_date: remaDate(transaction.PurchaseDate), merchant_name: transaction.StoreName || 'REMA 1000',
      raw_category: item.ProductGroupDescription || 'Unknown', product_name: item.Prodtxt1 || item.ProductDescription,
      quantity: numeric(item.Pieces, 1), amount: numeric(item.Amount), discount: numeric(item.Discount),
    }));
  }
  return rows;
}

function parseOda(data) {
  const rows = [];
  for (const [orderIndex, order] of (data.orders || []).entries()) {
    const transactionId = String(order.order_number || `order-${orderIndex}`);
    const lines = order.lines || [];
    const amounts = lines.map(line => numeric(line.gross_amount));
    const adjustment = numeric(order.gross_amount, amounts.reduce((a, b) => a + b, 0)) - amounts.reduce((a, b) => a + b, 0);
    if (amounts.length && Math.abs(adjustment) <= .5) amounts[amounts.length - 1] += adjustment;
    lines.forEach((line, index) => rows.push(canonicalRow({ source: 'Oda', line_id: `${transactionId}:${index}`, transaction_id: transactionId, purchase_date: order.delivered_time || order.payment_time || order.created_time, merchant_name: 'Oda', raw_category: 'Oda', product_name: line.product, quantity: numeric(line.quantity, 1), amount: amounts[index] })));
  }
  return rows;
}

function dataRows(data) {
  if (data.TransactionsInfo) return parseRema(data);
  if (Array.isArray(data.orders)) return parseOda(data);
  if (Array.isArray(data)) return data.map(canonicalRow);
  if (Array.isArray(data.rows)) return data.rows.map(canonicalRow);
  return [];
}

function applyJson(data, filename = '') {
  const kind = configKind(data, filename);
  if (kind) { state.config[kind] = data; return { config: 1, rows: 0 }; }
  const rows = dataRows(data);
  state.rows.push(...rows);
  return { config: 0, rows: rows.length };
}

function deduplicateAndReclassify() {
  const unique = new Map();
  for (const original of state.rows) {
    const row = canonicalRow(original);
    row.main = classifyMain(row.raw, row.product);
    row.sub = classifySub(row.main, row.raw, row.product);
    row.family = familyFor(row.product);
    unique.set(`${row.source}\u001f${row.lineId}`, row);
  }
  state.rows = [...unique.values()];
}

async function importFiles(files) {
  let imported = 0, configs = 0;
  for (const file of files) {
    try {
      const result = applyJson(JSON.parse(await file.text()), file.name);
      imported += result.rows; configs += result.config; state.loadedNames.add(file.name);
    } catch (error) { console.error(`Could not import ${file.name}`, error); }
  }
  deduplicateAndReclassify();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.rows));
  render();
  $('status').textContent = `Loaded ${number.format(state.rows.length)} lines; imported ${number.format(imported)} lines and ${configs} configuration file(s).`;
}

async function fetchJson(path, optional = true) {
  try {
    const response = await fetch(path, { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } catch (error) {
    if (!optional) console.error(path, error);
    return null;
  }
}

async function boot() {
  for (const path of CONFIG_PATHS) {
    const data = await fetchJson(path);
    if (data) applyJson(data, path);
  }
  if (!state.rows.length) {
    try { state.rows = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { state.rows = []; }
  }
  try { Object.assign(state.config.overrides, JSON.parse(localStorage.getItem(OVERRIDE_STORAGE_KEY) || '{}')); } catch { /* ignore corrupt local overrides */ }
  deduplicateAndReclassify();
  wireEvents(); render();
  $('status').textContent = state.rows.length ? `Loaded ${number.format(state.rows.length)} purchase lines from JSON.` : 'No data yet. Drop one or more JSON exports here.';
}

function filteredRows() {
  const query = normalized($('search').value);
  return state.rows.filter(row =>
    ($('source').value === 'All' || row.source === $('source').value) &&
    ($('main').value === 'All' || row.main === $('main').value) &&
    ($('sub').value === 'All' || row.sub === $('sub').value) &&
    (!$('dateFrom').value || row.date >= $('dateFrom').value) && (!$('dateTo').value || row.date <= $('dateTo').value) &&
    (!query || normalized(`${row.product} ${row.merchant} ${row.raw} ${row.main} ${row.sub}`).includes(query))
  );
}
function options(id, values) {
  const select = $(id), previous = select.value;
  select.replaceChildren(...['All', ...new Set(values)].sort().map(value => Object.assign(document.createElement('option'), { value, textContent: value })));
  if ([...select.options].some(option => option.value === previous)) select.value = previous;
}
function chart(id, entries, onClick) {
  const host = $(id); host.replaceChildren();
  const maximum = Math.max(1, ...entries.map(([, value]) => Math.abs(value)));
  for (const [label, value] of entries.slice(0, 14)) {
    const row = document.createElement('div'); row.className = 'bar-row';
    row.innerHTML = '<span class="bar-label"></span><span class="track"><span class="bar"></span></span><span class="value"></span>';
    row.children[0].textContent = label; row.children[1].firstElementChild.style.width = `${Math.abs(value) / maximum * 100}%`; row.children[2].textContent = `${money.format(value)} kr`;
    if (onClick) row.onclick = () => onClick(label); host.append(row);
  }
  if (!entries.length) host.innerHTML = '<div class="empty">No matching data</div>';
}
function grouped(rows, key) {
  const result = new Map();
  for (const row of rows) result.set(key(row), (result.get(key(row)) || 0) + row.amount);
  return [...result].sort((a, b) => b[1] - a[1]);
}
function groupedItems(rows) {
  const items = new Map();
  for (const row of rows) {
    const key = [row.source, row.main, row.sub, row.product, row.family, row.raw].join('\u001f');
    let item = items.get(key);
    if (!item) {
      item = { key, source: row.source, main: row.main, sub: row.sub, product: row.product, family: row.family, raw: row.raw, lines: 0, quantity: 0, spend: 0 };
      items.set(key, item);
    }
    item.lines += 1;
    item.quantity += row.quantity;
    item.spend += row.amount;
  }
  return [...items.values()].map(item => ({ ...item, average: item.quantity ? item.spend / item.quantity : 0 }));
}
function categoryCatalog() {
  const mains = new Set(Object.keys(state.config.subcategories || {}));
  for (const value of Object.values(state.config.main?.exact_mappings || {})) mains.add(value);
  for (const rule of state.config.main?.rules || []) mains.add(rule.target);
  for (const row of state.rows) mains.add(row.main);
  const subs = {};
  for (const main of mains) subs[main] = new Set((state.config.subcategories?.[main] || []).map(rule => rule.target));
  for (const row of state.rows) (subs[row.main] ||= new Set()).add(row.sub);
  return { mains: [...mains].filter(Boolean).sort(), subs };
}
function refreshMappingControls(preferredMain = '', preferredSub = '') {
  const catalog = categoryCatalog();
  const main = $('mapMain'), previousMain = preferredMain || main.value;
  main.replaceChildren(...catalog.mains.map(value => Object.assign(document.createElement('option'), { value, textContent: value })));
  if (catalog.mains.includes(previousMain)) main.value = previousMain;
  const subValues = [...(catalog.subs[main.value] || [])].filter(Boolean).sort();
  const sub = $('mapSub'), previousSub = preferredSub || sub.value;
  sub.replaceChildren(...subValues.map(value => Object.assign(document.createElement('option'), { value, textContent: value })));
  if (subValues.includes(previousSub)) sub.value = previousSub;
}
function updateMappingState() {
  $('applyMapping').disabled = !selectedItems.size || !$('mapMain').value || !$('mapSub').value;
  $('exportSelected').disabled = !selectedItems.size;
  $('downloadMappings').disabled = !pendingOverrides.size;
  $('mappingStatus').textContent = pendingOverrides.size
    ? `${number.format(selectedItems.size)} selected; ${number.format(pendingOverrides.size)} product mapping change(s) ready.`
    : selectedItems.size ? `${number.format(selectedItems.size)} purchase line item(s) selected.` : 'Select one or more purchase line items below to recategorise them.';
}
function exportSelectedItems() {
  const selected = groupedItems(state.rows).filter(item => selectedItems.has(item.key));
  const quote = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const columns = [
    ['Main category', 'main'],
    ['Subcategory', 'sub'],
    ['Product', 'product'],
    ['Family', 'family'],
    ['Raw category', 'raw'],
  ];
  const csv = `\uFEFF${columns.map(([label]) => quote(label)).join(',')}\n${selected.map(item => columns.map(([, key]) => quote(item[key])).join(',')).join('\n')}\n`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'selected_purchase_item_mappings.csv'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
function applySelectedMappings() {
  const main = $('mapMain').value, sub = $('mapSub').value;
  const selectedProducts = new Set(groupedItems(state.rows).filter(item => selectedItems.has(item.key)).map(item => item.product));
  for (const product of selectedProducts) {
    const key = normalized(product), existing = state.config.overrides[key] || {};
    const mapping = { ...existing, main, sub, family: existing.family || familyFor(product) };
    state.config.overrides[key] = mapping;
    pendingOverrides.set(key, mapping);
  }
  localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(state.config.overrides));
  selectedItems.clear();
  deduplicateAndReclassify();
  render();
}
function downloadMappings() {
  const blob = new Blob([`${JSON.stringify(state.config.overrides, null, 2)}\n`], { type: 'application/json' });
  const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'product_overrides.json'; link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}
function sortedItems(items) {
  const { key, direction } = tableSort;
  return items.sort((left, right) => {
    const a = left[key], b = right[key];
    if (typeof a === 'number' && typeof b === 'number') return (a - b) * direction;
    return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' }) * direction;
  });
}
function temporalAverages(rows) {
  const dated = rows.filter(row => /^\d{4}-\d{2}-\d{2}$/.test(row.date));
  const sources = [...new Set(dated.map(row => row.source))].sort();
  const daily = new Map();
  for (const row of dated) {
    const value = daily.get(row.date) || {};
    value[row.source] = (value[row.source] || 0) + row.amount;
    daily.set(row.date, value);
  }
  const averageBySource = values => Object.fromEntries(sources.map(source => [source, values.length ? values.reduce((sum, value) => sum + (value[source] || 0), 0) / values.length : 0]));
  const weekdayBuckets = Array.from({ length: 7 }, () => []);
  const months = new Map(), years = new Map();
  for (const [date, amounts] of daily) {
    const parsed = new Date(`${date}T12:00:00Z`);
    weekdayBuckets[(parsed.getUTCDay() + 6) % 7].push(amounts);
    const monthKey = date.slice(0, 7), year = date.slice(0, 4);
    const month = months.get(monthKey) || {};
    for (const source of sources) month[source] = (month[source] || 0) + (amounts[source] || 0);
    months.set(monthKey, month);
    if (!years.has(year)) years.set(year, []);
    years.get(year).push(amounts);
  }
  const monthBuckets = Array.from({ length: 12 }, () => []);
  for (const [monthKey, amounts] of months) monthBuckets[Number(monthKey.slice(5, 7)) - 1].push(amounts);
  return {
    sources,
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((label, index) => ({ label, values: averageBySource(weekdayBuckets[index]) })),
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].map((label, index) => ({ label, values: averageBySource(monthBuckets[index]) })),
    years: [...years].sort(([a], [b]) => a.localeCompare(b)).map(([label, values]) => ({ label, values: averageBySource(values) })),
  };
}
function sourceColor(source, sources) {
  const palette = ['#176b3a', '#4b83c3', '#d4853a', '#9a5bb1', '#4e9d9d', '#c15b73'];
  return palette[sources.indexOf(source) % palette.length];
}
function stackedTimelineChart(id, entries, sources) {
  const host = $(id); host.replaceChildren();
  if (!entries.length || !sources.length) { host.innerHTML = '<div class="empty">No matching data</div>'; return; }
  const ns = 'http://www.w3.org/2000/svg', width = 440, height = 250, left = 38, right = 8, top = 12, bottom = 38;
  const plotWidth = width - left - right, plotHeight = height - top - bottom;
  const totals = entries.map(entry => sources.reduce((sum, source) => sum + (entry.values[source] || 0), 0));
  const maximum = Math.max(1, ...totals);
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${width} ${height}`); svg.setAttribute('role', 'img');
  const add = (name, attributes, text = '') => { const node = document.createElementNS(ns, name); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); if (text) node.textContent = text; svg.append(node); return node; };
  for (let step = 0; step <= 4; step += 1) {
    const y = top + plotHeight - step / 4 * plotHeight;
    add('line', { x1: left, x2: width - right, y1: y, y2: y, class: 'timeline-gridline' });
    add('text', { x: left - 5, y: y + 4, 'text-anchor': 'end', class: 'timeline-axis-label' }, money.format(maximum * step / 4));
  }
  const slot = plotWidth / entries.length, barWidth = Math.max(5, Math.min(38, slot * .7));
  entries.forEach((entry, index) => {
    const x = left + index * slot + (slot - barWidth) / 2;
    let stacked = 0;
    for (const source of sources) {
      const value = entry.values[source] || 0;
      if (!value) continue;
      const barHeight = value / maximum * plotHeight;
      const y = top + plotHeight - stacked - barHeight;
      const rect = add('rect', { x, y, width: barWidth, height: barHeight, fill: sourceColor(source, sources), class: 'timeline-segment' });
      const title = document.createElementNS(ns, 'title'); title.textContent = `${entry.label}: ${source} ${money.format(value)} kr`; rect.append(title);
      stacked += barHeight;
    }
    add('text', { x: x + barWidth / 2, y: height - 13, 'text-anchor': 'middle', class: 'timeline-axis-label' }, entry.label);
  });
  add('line', { x1: left, x2: width - right, y1: top + plotHeight, y2: top + plotHeight, class: 'timeline-axis' });
  host.append(svg);
  const legend = document.createElement('div'); legend.className = 'timeline-legend';
  for (const source of sources) {
    const item = document.createElement('span'); item.innerHTML = `<i style="background:${sourceColor(source, sources)}"></i>`; item.append(document.createTextNode(source)); legend.append(item);
  }
  host.append(legend);
}
function render() {
  options('source', state.rows.map(row => row.source)); options('main', state.rows.map(row => row.main));
  options('sub', state.rows.filter(row => $('main').value === 'All' || row.main === $('main').value).map(row => row.sub));
  const rows = filteredRows();
  $('totalSpend').textContent = `${money.format(rows.reduce((sum, row) => sum + row.amount, 0))} kr`;
  $('lineCount').textContent = number.format(rows.length); $('productCount').textContent = number.format(new Set(rows.map(row => normalized(row.product))).size); $('transactionCount').textContent = number.format(new Set(rows.map(row => `${row.source}:${row.transactionId}`)).size);
  chart('categoryChart', grouped(rows, row => row.main), label => { $('main').value = label; render(); });
  chart('subcategoryChart', grouped(rows, row => row.sub), label => { $('sub').value = label; render(); });
  const timelines = temporalAverages(rows);
  stackedTimelineChart('weekdayChart', timelines.weekdays, timelines.sources);
  stackedTimelineChart('monthChart', timelines.months, timelines.sources);
  stackedTimelineChart('yearChart', timelines.years, timelines.sources);
  const items = sortedItems(groupedItems(rows));
  refreshMappingControls();
  document.querySelectorAll('th[data-sort]').forEach(header => {
    if (header.dataset.sort === tableSort.key) header.dataset.direction = tableSort.direction === 1 ? 'asc' : 'desc';
    else delete header.dataset.direction;
  });
  $('rows').replaceChildren(...items.slice(0, 1000).map(row => {
    const tr = document.createElement('tr');
    if (selectedItems.has(row.key)) tr.className = 'selected-row';
    const selectionCell = document.createElement('td'); selectionCell.className = 'select-cell';
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedItems.has(row.key); checkbox.setAttribute('aria-label', `Select ${row.product}`);
    checkbox.onclick = event => {
      const visibleItems = items.slice(0, 1000), anchorIndex = visibleItems.findIndex(item => item.key === selectionAnchorKey), currentIndex = visibleItems.findIndex(item => item.key === row.key);
      if (event.shiftKey && anchorIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(anchorIndex, currentIndex), end = Math.max(anchorIndex, currentIndex);
        for (const item of visibleItems.slice(start, end + 1)) {
          if (checkbox.checked) selectedItems.add(item.key); else selectedItems.delete(item.key);
        }
      } else if (checkbox.checked) selectedItems.add(row.key); else selectedItems.delete(row.key);
      selectionAnchorKey = row.key;
      render();
    };
    selectionCell.append(checkbox); tr.append(selectionCell);
    for (const [value, className] of [[row.source], [row.main], [row.sub], [row.product], [row.family], [row.raw], [number.format(row.lines), 'number'], [number.format(row.quantity), 'number'], [`${money.format(row.average)} kr`, 'number'], [`${money.format(row.spend)} kr`, 'number']]) { const td = document.createElement('td'); td.textContent = value; if (className) td.className = className; tr.append(td); }
    return tr;
  }));
  const visibleKeys = items.slice(0, 1000).map(item => item.key);
  $('selectVisible').checked = visibleKeys.length > 0 && visibleKeys.every(key => selectedItems.has(key));
  $('selectVisible').indeterminate = visibleKeys.some(key => selectedItems.has(key)) && !$('selectVisible').checked;
  updateMappingState();
  $('visibleCount').textContent = items.length > 1000 ? `Showing 1,000 of ${number.format(items.length)} grouped items` : `${number.format(items.length)} grouped items`;
}

function wireEvents() {
  for (const id of ['source', 'main', 'sub', 'search', 'dateFrom', 'dateTo']) $(id).addEventListener('input', render);
  $('reset').onclick = () => { for (const id of ['source', 'main', 'sub']) $(id).value = 'All'; for (const id of ['search', 'dateFrom', 'dateTo']) $(id).value = ''; render(); };
  $('fileInput').onchange = event => importFiles(event.target.files);
  $('clearData').onclick = () => { state.rows = []; localStorage.removeItem(STORAGE_KEY); render(); $('status').textContent = 'Browser data cleared. Drop JSON files here to begin.'; };
  $('mapMain').onchange = () => { refreshMappingControls($('mapMain').value); updateMappingState(); };
  $('mapSub').onchange = updateMappingState;
  $('applyMapping').onclick = applySelectedMappings;
  $('exportSelected').onclick = exportSelectedItems;
  $('downloadMappings').onclick = downloadMappings;
  $('selectVisible').onchange = event => {
    for (const item of sortedItems(groupedItems(filteredRows())).slice(0, 1000)) {
      if (event.target.checked) selectedItems.add(item.key); else selectedItems.delete(item.key);
    }
    selectionAnchorKey = null;
    render();
  };
  document.querySelectorAll('th[data-sort]').forEach(header => header.addEventListener('click', () => {
    const key = header.dataset.sort;
    if (tableSort.key === key) tableSort.direction *= -1;
    else { tableSort.key = key; tableSort.direction = ['lines', 'quantity', 'average', 'spend'].includes(key) ? -1 : 1; }
    render();
  }));
  const drop = $('dropZone');
  for (const eventName of ['dragenter', 'dragover']) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.add('dragging'); });
  for (const eventName of ['dragleave', 'drop']) drop.addEventListener(eventName, event => { event.preventDefault(); drop.classList.remove('dragging'); });
  drop.addEventListener('drop', event => importFiles([...event.dataTransfer.files].filter(file => file.name.toLowerCase().endsWith('.json'))));
}

boot();
