-- Back to the old default for workspaces still named the new one.

UPDATE workspaces w
   SET name = left(d.first, 53) || '''s team',
       updated_at = now()
  FROM (SELECT id, coalesce(nullif(split_part(btrim(coalesce(name, '')), ' ', 1), ''), split_part(email, '@', 1)) AS first FROM users) d
 WHERE d.id = w.owner_user_id
   AND w.name IN (d.first || '''s workspace', left(d.first, 48) || '''s workspace');
