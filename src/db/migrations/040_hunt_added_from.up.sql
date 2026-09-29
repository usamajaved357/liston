-- Where a product hunted as its eBay listing alone came from: Discover (hunting new products by
-- category) or Product research (one product's market). found_by_liston stays "added without a
-- supplier, never approved as added" for both; this says which tool, so the Overview and the
-- product's page never mix the two up. NULL: added with its supplier by a hunter.
ALTER TABLE hunted_products ADD COLUMN added_from TEXT CHECK (added_from IN ('discover', 'research'));

UPDATE hunted_products h SET added_from = 'discover'
 WHERE h.found_by_liston
   AND EXISTS (
     SELECT 1 FROM member_activity a
      WHERE a.subject_type = 'hunt' AND a.subject_id = h.id::text AND a.kind = 'hunt.added' AND a.detail->>'fromDiscover' = 'true'
   );
