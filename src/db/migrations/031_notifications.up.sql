-- What Liston tells a person (a reviewer approved, rejected or sent back
-- their hunted product, or removed it), shown in the bell and pushed to
-- their browser. And each browser a person turned push notifications on in.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who it's for
  actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,     -- who caused it
  kind TEXT NOT NULL,                     -- 'hunt.approved' | 'hunt.rejected' | 'hunt.sent_back' | 'hunt.removed'
  title TEXT NOT NULL,
  body TEXT,
  url TEXT,                               -- where it opens, inside Liston
  subject_type TEXT,
  subject_id TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX idx_notifications_unread ON notifications(user_id) WHERE read_at IS NULL;

CREATE TABLE push_subscriptions (
  endpoint TEXT PRIMARY KEY,              -- the browser's push service address, one per browser
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_sent_at TIMESTAMPTZ
);
CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
