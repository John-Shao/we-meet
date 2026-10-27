#!/bin/bash
# Create Temporal database and user in existing PostgreSQL

echo "==> Creating temporal user..."
kubectl exec -n meet postgresql-0 -- psql -U postgres -c "CREATE ROLE temporal WITH LOGIN PASSWORD 'temporal-staging-2026';" 2>&1 || echo "User may already exist"

echo "==> Creating temporal_staging database..."
kubectl exec -n meet postgresql-0 -- psql -U postgres -c "CREATE DATABASE temporal_staging OWNER temporal;" 2>&1 || echo "Database may already exist"

echo "==> Granting connect privilege..."
kubectl exec -n meet postgresql-0 -- psql -U postgres -c "GRANT CONNECT ON DATABASE temporal_staging TO temporal;"

echo "==> Creating schemas..."
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "CREATE SCHEMA IF NOT EXISTS temporal AUTHORIZATION temporal;"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "CREATE SCHEMA IF NOT EXISTS temporal_visibility AUTHORIZATION temporal;"

echo "==> Granting permissions..."
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "GRANT ALL ON SCHEMA temporal TO temporal;"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "GRANT ALL ON SCHEMA temporal_visibility TO temporal;"

kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "ALTER DEFAULT PRIVILEGES IN SCHEMA temporal GRANT ALL ON TABLES TO temporal;"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "ALTER DEFAULT PRIVILEGES IN SCHEMA temporal GRANT ALL ON SEQUENCES TO temporal;"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "ALTER DEFAULT PRIVILEGES IN SCHEMA temporal GRANT ALL ON FUNCTIONS TO temporal;"

kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "ALTER DEFAULT PRIVILEGES IN SCHEMA temporal_visibility GRANT ALL ON TABLES TO temporal;"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "ALTER DEFAULT PRIVILEGES IN SCHEMA temporal_visibility GRANT ALL ON SEQUENCES TO temporal;"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "ALTER DEFAULT PRIVILEGES IN SCHEMA temporal_visibility GRANT ALL ON FUNCTIONS TO temporal;"

echo "=== Verification ==="
echo "Schemas:"
kubectl exec -n meet postgresql-0 -- psql -U postgres -d temporal_staging -c "\dn"
echo "User:"
kubectl exec -n meet postgresql-0 -- psql -U postgres -c "\du temporal"
echo "Database:"
kubectl exec -n meet postgresql-0 -- psql -U postgres -c "\l temporal_staging"
