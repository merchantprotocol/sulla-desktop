-- Plaintext copy of each item's agent policy so the service can refuse agent use without decrypting.
ALTER TABLE items ADD COLUMN IF NOT EXISTS agent_policy jsonb NOT NULL DEFAULT '{"mode":"only_me","level":"metadata","agents":[],"sites":[],"expiresAt":null,"askFirst":false,"allowServerAgents":false}'::jsonb;
