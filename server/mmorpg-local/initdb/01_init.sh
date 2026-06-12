#!/bin/bash
# Выполняется официальным entrypoint'ом postgres при ПЕРВОМ старте тома.
# Создаёт три БД (периметры) и сервисные роли, затем накатывает схемы.
set -euo pipefail

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" <<-SQL
    CREATE ROLE auth_svc    LOGIN PASSWORD 'auth_svc_dev';
    CREATE ROLE billing_svc LOGIN PASSWORD 'billing_svc_dev';
    CREATE ROLE game_rw     LOGIN PASSWORD 'game_rw_dev';

    CREATE DATABASE mmo_auth;
    CREATE DATABASE mmo_billing;
    CREATE DATABASE mmo_game;
SQL

psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mmo_auth    -f /docker-entrypoint-initdb.d/sql/10_auth_schema.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mmo_billing -f /docker-entrypoint-initdb.d/sql/20_billing_schema.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mmo_game    -f /docker-entrypoint-initdb.d/sql/30_game_schema.sql
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d mmo_game    -f /docker-entrypoint-initdb.d/sql/40_game_seed.sql

echo ">>> mmo_auth / mmo_billing / mmo_game созданы и проинициализированы"
