-- Initialize Temporal database schemas
-- Run as postgres superuser after Bitnami chart creates the database

-- Temporal visibility schema (for workflow search)
CREATE SCHEMA IF NOT EXISTS temporal_visibility;
GRANT ALL ON SCHEMA temporal_visibility TO temporal;
GRANT ALL ON ALL TABLES IN SCHEMA temporal_visibility TO temporal;
ALTER DEFAULT PRIVILEGES IN SCHEMA temporal_visibility GRANT ALL ON TABLES TO temporal;
ALTER DEFAULT PRIVILEGES IN SCHEMA temporal_visibility GRANT ALL ON SEQUENCES TO temporal;
ALTER DEFAULT PRIVILEGES IN SCHEMA temporal_visibility GRANT ALL ON FUNCTIONS TO temporal;

-- Temporal default schema (for workflow execution)
CREATE SCHEMA IF NOT EXISTS temporal;
GRANT ALL ON SCHEMA temporal TO temporal;
GRANT ALL ON ALL TABLES IN SCHEMA temporal TO temporal;
ALTER DEFAULT PRIVILEGES IN SCHEMA temporal GRANT ALL ON TABLES TO temporal;
ALTER DEFAULT PRIVILEGES IN SCHEMA temporal GRANT ALL ON SEQUENCES TO temporal;
ALTER DEFAULT PRIVILEGES IN SCHEMA temporal GRANT ALL ON FUNCTIONS TO temporal;

-- Verify
\dn
\du temporal
