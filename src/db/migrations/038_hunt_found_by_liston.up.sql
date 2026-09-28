-- A product Liston's own supplier search found (Discover's Hunt, "Find with
-- Liston" in the add form) and someone added. It is never approved as it's
-- added, the owner's included: it waits for a person to open it and approve
-- or reject it, and the reviewer who added it may decide on it (it isn't
-- their own find).
ALTER TABLE hunted_products ADD COLUMN found_by_liston BOOLEAN NOT NULL DEFAULT false;
