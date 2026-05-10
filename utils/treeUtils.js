const { pool } = require('../db');

async function loadAllUsers() {
  const result = await pool.query('SELECT id, name, parent_id, parents FROM users');
  const rows = result.rows;

  rows.forEach(r => {
    try {
      r.parents = r.parents ? JSON.parse(r.parents) : [];
    } catch(e) {
      r.parents = [];
    }
  });

  return rows;
}

function buildAdjacency(rows) {
  const map = {};
  rows.forEach(r => {
    const parentsList = (Array.isArray(r.parents) && r.parents.length > 0) ? r.parents : (r.parent_id ? [r.parent_id] : []);
    map[r.id] = { id: r.id, parents: parentsList, children: [] };
  });
  // build children lists
  Object.values(map).forEach(n => {
    (n.parents || []).forEach(p => { if (map[p]) map[p].children.push(n.id); });
  });
  return map;
}

function isDescendant(map, ancestorId, descendantId) {
  // DFS from ancestorId to see if reachable descendantId
  const stack = [ancestorId];
  const seen = new Set();
  while (stack.length) {
    const cur = stack.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    const node = map[cur];
    if (!node) continue;
    for (const c of node.children) { if (c === descendantId) return true; stack.push(c); }
  }
  return false;
}

async function validateParents(userId, parents) {
  if (!parents) return { ok: true, parents: [] };
  if (!Array.isArray(parents)) return { ok: false, error: 'parents must be array' };

  const uniq = Array.from(new Set(
    parents.map(x => parseInt(x)).filter(x => !Number.isNaN(x))
  ));

  if (uniq.length > 0) {
    const result = await pool.query(
      `SELECT id FROM users WHERE id = ANY($1)`,
      [uniq]
    );

    const found = result.rows;

    if (found.length !== uniq.length)
      return { ok: false, error: 'one or more parents not found' };
  }

  const rows = await loadAllUsers();

  const map = buildAdjacency(rows);
  if (!map[userId])
    map[userId] = { id: userId, parents: uniq || [], children: [] };

  Object.values(map).forEach(n => {
    if (n) {
      n.children = [];
    }
  });

  Object.values(map).forEach(n => {
    if (!n) return;

    if (!Array.isArray(n.parents)) {
      n.parents = [];
    }

    if (!Array.isArray(n.children)) {
      n.children = [];
    }

    n.parents.forEach(p => {
      if (map[p]) {
        if (!Array.isArray(map[p].children)) {
          map[p].children = [];
        }
        map[p].children.push(n.id);
      }
    });
  });

  for (const p of uniq) {
    if (p === userId)
      return { ok: false, error: 'cannot set self as parent' };

    if (isDescendant(map, userId, p))
      return { ok: false, error: 'cycle detected' };
  }

  return { ok: true, parents: uniq };
}

module.exports = { loadAllUsers, buildAdjacency, isDescendant, validateParents };
