-- Teams are called workspaces in Liston now ("Usama's workspace"). A
-- workspace still named the old default ("Usama's team": the owner's first
-- name, else their email's name part) takes the new one; a name the owner
-- chose stays as it is.

UPDATE workspaces w
   SET name = left(d.first, 48) || '''s workspace',
       updated_at = now()
  FROM (SELECT id, coalesce(nullif(split_part(btrim(coalesce(name, '')), ' ', 1), ''), split_part(email, '@', 1)) AS first FROM users) d
 WHERE d.id = w.owner_user_id
   AND w.name IN (d.first || '''s team', left(d.first, 50) || '''s team', left(d.first, 53) || '''s team');
