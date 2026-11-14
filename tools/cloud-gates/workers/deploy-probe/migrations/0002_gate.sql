-- Gate G11 probe schema, version 2: withheld from the first push so a redeploy must apply it.
UPDATE gate_meta SET v = '2' WHERE k = 'schema';
INSERT INTO gate_meta (k, v) VALUES ('gate', '0002-applied');
