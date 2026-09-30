const { query } = require('../../db/client');

// The files table (migration 041): what Liston knows about each shared file.

async function insert(f) {
  const { rows } = await query(
    `INSERT INTO files (id, owner_user_id, uploaded_by, purpose, storage_key, thumb_key, name, mime, size_bytes, width, height, public_token, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING *`,
    [f.id, f.ownerId, f.uploadedBy, f.purpose, f.storageKey, f.thumbKey || null, f.name, f.mime, f.size, f.width ?? null, f.height ?? null, f.publicToken || null, f.expiresAt || null]
  );
  return rows[0];
}

async function findById(id) {
  const { rows } = await query(`SELECT * FROM files WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByIds(ids) {
  if (!ids.length) return [];
  const { rows } = await query(`SELECT * FROM files WHERE id = ANY($1::uuid[])`, [ids]);
  return rows;
}

async function findByPublicToken(token) {
  const { rows } = await query(`SELECT * FROM files WHERE public_token = $1 AND (expires_at IS NULL OR expires_at > now())`, [token]);
  return rows[0] || null;
}

/** Files past their expiry (eBay attachments after 30 days), a batch at a time. */
async function findExpired(limit = 200) {
  const { rows } = await query(`SELECT * FROM files WHERE expires_at IS NOT NULL AND expires_at <= now() ORDER BY expires_at LIMIT $1`, [limit]);
  return rows;
}

async function remove(id) {
  await query(`DELETE FROM files WHERE id = $1`, [id]);
}

module.exports = { insert, findById, findByIds, findByPublicToken, findExpired, remove };
