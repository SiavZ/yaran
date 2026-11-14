-- Gate G11 probe schema, version 1: one key/value table the /v1/meta route reads back.
CREATE TABLE gate_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
INSERT INTO gate_meta (k, v) VALUES ('schema', '1');
