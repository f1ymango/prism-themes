// C4: roles → selectors → stylesheet. Written once and used twice: the mod's tests import this module, and the
// install pastes it into prism.js (without its `export` words), so the page runs exactly what was tested.

/** For each role, the first of its selectors that matches now, or null. `matches(selector)` asks the page. */
export function resolveRoles(roles, matches) {
  const out = {};
  for (const [name, selectors] of Object.entries(roles)) {
    out[name] = selectors.find(s => {
      try { return matches(s); } catch { return false; }
    }) ?? null;
  }
  return out;
}

/** Keeps the rules whose roles all resolved, with `@{role}` spelled as its selector; names the ones dropped. */
export function compileRules(rules, resolved) {
  const kept = [];
  const dropped = [];
  for (const rule of rules) {
    if (rule.roles.every(n => resolved[n])) kept.push(rule.css.replace(/@\{([a-zA-Z]+)\}/g, (m, n) => resolved[n] ?? m));
    else dropped.push(rule.id);
  }
  return { css: kept.join('\n'), dropped };
}

/** A page-drawn background makes the page transparent: only once the panels that keep text readable are there. */
export function wallReady(resolved) {
  return !!resolved.composer && !!(resolved.transcript || resolved.startCard);
}

/** A key that changes only when what resolved changes, so the stylesheet is rebuilt only then. */
export function resolvedKey(resolved) {
  return Object.entries(resolved).map(([k, v]) => `${k}=${v ?? ''}`).join('|');
}
