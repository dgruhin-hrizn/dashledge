// The Marketplace tab in Settings: reviewed plugins from Dashledge's registry.
// Rust fetches and verifies the signed catalog, downloads and checks every package,
// and installs only bytes it verified (src-tauri/src/marketplace.rs). This page only
// shows what Rust returns and asks it to act.
import {packageFacts} from './package-manifest.js';

// First-party plugins: built and released by Dashledge from dashledge-official-plugins.
// The registry admits only Dashledge maintainers under this prefix, so a plugin from the
// signed catalog with this ID is Dashledge's own. A copy installed from a file or loaded
// from a folder is not: it shows as Unverified or Unpacked like any other.
export const FIRST_PARTY = 'plugin.dashledge.';
export const isFirstParty = (id, origin = 'marketplace') => origin === 'marketplace' && typeof id === 'string' && id.startsWith(FIRST_PARTY);

// Who a catalog plugin is by. Every catalog entry comes from the signed catalog.
export const pluginPublisher = plugin => isFirstParty(plugin.id) ? 'Dashledge' : plugin.publisher;

// Group the catalog's plugins by category, filtered by a search query, with the
// plugins that need attention (updates, pulled versions) listed first.
export function marketplaceGroups(view, query = '') {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = plugin => {
    const text = [plugin.title, plugin.summary, plugin.publisher, plugin.category, plugin.id].filter(Boolean).join(' ').toLowerCase();
    return words.every(word => text.includes(word));
  };
  const plugins = (view?.plugins || []).filter(matches);
  const attention = plugins.filter(p => p.update || p.pulled);
  const groups = new Map();
  for (const plugin of plugins) {
    const category = plugin.category || 'Other';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(plugin);
  }
  const sorted = [...groups].sort(([a], [b]) => (a === 'Other') - (b === 'Other') || a.localeCompare(b));
  for (const [, list] of sorted) list.sort((a, b) => a.title.localeCompare(b.title));
  return {attention, groups: sorted};
}

// One short status for a plugin card.
export function pluginStatus(plugin) {
  if (plugin.pulled) return {label: 'Pulled', tone: 'danger', text: 'This version was pulled: ' + plugin.pulled};
  if (plugin.update) return plugin.updateAdds?.length
    ? {label: 'Update needs approval', tone: 'warning', text: 'Version ' + plugin.update + ' asks for more access.'}
    : {label: 'Update available', tone: 'accent', text: 'Version ' + plugin.update + ' is ready.'};
  if (plugin.installed) {
    if (plugin.origin === 'marketplace') return {label: 'Installed', tone: 'ok', text: 'Version ' + plugin.installed + ' from the Marketplace.'};
    if (plugin.origin === 'unpacked') return {label: 'Unpacked', tone: 'muted', text: 'A folder with this ID is loaded in Widget Studio.'};
    return {label: 'Unverified', tone: 'muted', text: 'Installed from a file, not from the Marketplace.'};
  }
  if (!plugin.available) return {label: 'Needs a newer Dashledge', tone: 'muted', text: 'Update Dashledge in About to install it.'};
  return null;
}

// The main action a plugin card offers, if any.
export function pluginAction(plugin) {
  if (plugin.origin === 'unpacked') return null;
  if (plugin.update) return {label: plugin.updateAdds?.length ? 'Review update' : 'Update', version: plugin.update};
  if (plugin.pulled && plugin.available && plugin.available !== plugin.installed) return {label: 'Install ' + plugin.available, version: plugin.available};
  if (!plugin.installed && plugin.available) return {label: 'Install', version: plugin.available};
  if (plugin.installed && plugin.origin !== 'marketplace' && plugin.available) return {label: 'Replace with Marketplace version', version: plugin.available};
  return null;
}

// What an author does after Widget Studio saves their package for the Marketplace.
export function submissionSteps(prepared) {
  const {repo, tag, asset} = prepared.listing.source;
  return [
    'Saved ' + asset + ' (' + Math.ceil(prepared.size / 1024) + ' KiB, sha256 ' + prepared.sha256.slice(0, 12) + '…).',
    'Publish a release tagged ' + tag + ' in github.com/' + repo + ' and attach ' + asset + ' to it. If your code lives in another repository, change "source" in the listing below to match.',
    'Open GitHub to propose listings/' + prepared.id + '/' + prepared.version + '.json. GitHub copies the registry to your account and opens the pull request.',
    'Registry checks run on the pull request, then a maintainer reviews it. Once it merges, the plugin appears in every Marketplace within a few minutes.',
  ];
}

// The submission sheet's contents, for the editor's form dialog.
export function submissionFields(el, prepared) {
  const steps = el('ol', 'market-steps');
  for (const step of submissionSteps(prepared)) steps.append(el('li', '', step));
  const listing = el('pre', 'market-listing', JSON.stringify(prepared.listing, null, 2));
  listing.tabIndex = 0;
  listing.setAttribute('aria-label', 'Listing file');
  return [steps, listing];
}

// Installed plugins can be removed from the Marketplace too. An author's unpacked folder
// is only unlinked, which Widget Studio does.
export const pluginCanRemove = plugin => !!plugin.installed && plugin.origin !== 'unpacked';

export const publishedDate = seconds => new Date(seconds * 1000).toLocaleDateString(undefined, {year: 'numeric', month: 'short', day: 'numeric'});

// Render the tab. `ui` carries the Settings page's helpers so this module has no
// dependency on the editor: {main, invoke, el, button, row, heading, notice, installSheet, rerender}.
export function renderMarketplace(ui, state) {
  const {main, invoke, el, button, row, heading, notice} = ui;
  const images = state.images ??= new Map();
  const image = (path, alt, cls) => {
    const img = el('img', cls);
    img.alt = alt;
    img.loading = 'lazy';
    const cached = images.get(path);
    if (cached) img.src = cached;
    else invoke('marketplace_image', {path}).then(src => { images.set(path, src); img.src = src; }).catch(() => img.classList.add('missing'));
    return img;
  };
  const load = async refresh => {
    state.loading = true;
    try {
      state.view = await invoke('marketplace_catalog', {refresh});
      state.error = '';
      await ui.syncLayout?.();
    } catch (e) {
      state.error = e?.message || String(e);
    } finally {
      state.loading = false;
      ui.rerender();
    }
  };
  const remove = plugin => ui.removePackage(plugin.id, plugin.title, () => load(false));
  const removeButton = plugin => {
    const b = button('Remove', () => remove(plugin), 'quiet');
    b.setAttribute('aria-label', 'Remove ' + plugin.title);
    return b;
  };
  const install = async (plugin, version) => {
    try {
      const sheet = await invoke('marketplace_inspect', {id: plugin.id, version});
      // Refresh only after Settings has recorded the package in the layout.
      ui.installSheet(sheet, () => invoke('marketplace_install', {id: plugin.id, version}), () => load(false));
    } catch (e) { notice(e?.message || String(e)); }
  };

  const check = button('Check for updates', async () => {
    check.disabled = true;
    try {
      const result = await invoke('marketplace_check');
      const parts = [];
      if (result.updated.length) parts.push(result.updated.length + ' updated');
      if (result.needsApproval.length) parts.push(result.needsApproval.length + ' waiting for your approval');
      if (result.pulled.length) parts.push(result.pulled.length + ' pulled');
      notice(parts.length ? 'Marketplace: ' + parts.join(', ') + '.' : 'Everything from the Marketplace is up to date.');
      await load(false);
    } catch (e) { notice(e?.message || String(e)); } finally { check.disabled = false; }
  });
  const auto = el('input');
  auto.type = 'checkbox';
  auto.id = 'market-auto';
  auto.checked = state.view?.autoUpdate ?? true;
  auto.onchange = () => invoke('marketplace_set_auto_update', {on: auto.checked})
    .then(() => notice(auto.checked ? 'Updates that ask for nothing new install on their own.' : 'Every update waits for you.'))
    .catch(e => { auto.checked = !auto.checked; notice(e?.message || String(e)); });
  const autoLabel = el('label', 'market-auto', 'Update automatically');
  autoLabel.htmlFor = 'market-auto';
  autoLabel.prepend(auto);
  const actions = row(autoLabel, check);
  actions.classList.add('market-actions');
  main.append(heading('Marketplace', actions));

  if (!state.view && !state.error) {
    main.append(el('p', 'market-empty', 'Loading the Marketplace…'));
    if (!state.loading) load(false);
    return;
  }
  if (state.error && !state.view) {
    const p = el('section', 'panel market-empty');
    p.append(el('p', '', state.error), button('Try again', () => { state.error = ''; ui.rerender(); }));
    main.append(p);
    return;
  }
  const view = state.view;
  if (view.expired) main.append(el('p', 'market-note', 'The Marketplace catalog is out of date, so installs and updates are paused. Pulled versions still turn off.'));

  if (state.detail) {
    const plugin = view.plugins.find(p => p.id === state.detail);
    if (plugin) return detail(plugin);
    state.detail = null;
  }

  const search = el('input', 'market-search');
  search.type = 'search';
  search.placeholder = 'Search plugins';
  search.setAttribute('aria-label', 'Search plugins');
  search.value = state.query || '';
  const results = el('div', 'market-results');
  search.oninput = () => { state.query = search.value; draw(); };
  main.append(search, results);
  draw();

  function firstPartyBadge() {
    const badge = el('span', 'market-badge first-party', 'Dashledge');
    badge.title = 'Built and released by Dashledge.';
    return badge;
  }

  function card(plugin) {
    const article = el('article', 'panel studio-card market-card');
    const title = el('div', 'card-title');
    const name = el('h3');
    const open = button(plugin.title, () => { state.detail = plugin.id; ui.rerender(); }, 'market-open');
    open.setAttribute('aria-label', 'Open ' + plugin.title);
    name.append(open);
    title.append(image(plugin.icon, '', 'market-icon'), name);
    article.append(title, el('p', 'card-description', plugin.summary || ''));
    const status = pluginStatus(plugin), action = pluginAction(plugin);
    // A pulled version or an update that asks for more says why on the card itself.
    if (status && (status.tone === 'danger' || status.tone === 'warning')) article.append(el('p', 'market-status ' + status.tone, status.text));
    article.append(el('small', 'card-meta', 'by ' + pluginPublisher(plugin) + (plugin.available ? ' · v' + plugin.available : '')));
    const actions = row();
    if (isFirstParty(plugin.id)) actions.append(firstPartyBadge());
    if (status) {
      const badge = el('span', 'market-badge ' + status.tone, status.label);
      badge.title = status.text;
      actions.append(badge);
    }
    if (action) actions.append(button(action.label, () => install(plugin, action.version), 'primary'));
    if (pluginCanRemove(plugin)) actions.append(removeButton(plugin));
    article.append(actions);
    return article;
  }

  function draw() {
    const {attention, groups} = marketplaceGroups(view, state.query);
    results.replaceChildren();
    if (!groups.length) {
      results.append(el('p', 'market-empty', view.plugins.length ? 'No plugins match “' + state.query + '”.' : 'No plugins are published yet.'));
      return;
    }
    if (attention.length && !state.query) {
      const s = el('section', 'studio-group');
      s.append(el('h2', 'studio-heading', 'Needs your attention'));
      const grid = el('div', 'studio-grid');
      for (const plugin of attention) grid.append(card(plugin));
      s.append(grid);
      results.append(s);
    }
    for (const [category, list] of groups) {
      const s = el('section', 'studio-group');
      s.append(el('h2', 'studio-heading', category));
      const grid = el('div', 'studio-grid');
      for (const plugin of list) grid.append(card(plugin));
      s.append(grid);
      results.append(s);
    }
  }

  function detail(plugin) {
    const back = button('Back to the Marketplace', () => { state.detail = null; ui.rerender(); });
    const section = el('section', 'panel market-detail');
    const top = el('div', 'card-title');
    const name = el('div');
    const by = el('p', 'card-meta', 'by ' + pluginPublisher(plugin));
    if (isFirstParty(plugin.id)) by.append(' ', firstPartyBadge());
    name.append(el('h2', '', plugin.title), by);
    top.append(image(plugin.icon, '', 'market-icon large'), name);
    section.append(top);
    if (plugin.summary) section.append(el('p', '', plugin.summary));
    const newest = plugin.versions[0];
    const facts = packageFacts({version: plugin.available || newest?.version, license: plugin.license, homepage: plugin.homepage,
      minAppVersion: plugin.versions.find(v => v.version === plugin.available)?.minAppVersion});
    if (facts) section.append(el('p', 'package-facts', facts));
    const status = pluginStatus(plugin), action = pluginAction(plugin);
    if (status) section.append(el('p', 'market-status ' + status.tone, status.text));
    const buttons = row();
    if (action) buttons.append(button(action.label, () => install(plugin, action.version), 'primary'));
    if (pluginCanRemove(plugin)) buttons.append(removeButton(plugin));
    if (buttons.childElementCount) section.append(buttons);
    if (plugin.screenshots?.length) {
      const shots = el('div', 'market-shots');
      plugin.screenshots.forEach((path, i) => shots.append(image(path, plugin.title + ' screenshot ' + (i + 1), 'market-shot')));
      section.append(shots);
    }
    const history = el('ul', 'market-versions');
    for (const v of plugin.versions) {
      const item = el('li');
      item.append(el('strong', '', v.version), el('span', 'card-meta', ' · ' + publishedDate(v.published)));
      if (v.notes) item.append(el('p', '', v.notes));
      history.append(item);
    }
    section.append(el('h3', '', 'Versions'), history);
    main.append(row(back), section);
  }
}
