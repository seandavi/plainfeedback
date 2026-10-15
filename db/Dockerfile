# Postgres with the app-role init scripts baked in (first init only). COPY --chmod makes them
# readable by the postgres user whatever the host umask is (#103).
FROM postgres:17-alpine
COPY --chmod=0755 10-app-role.sh /docker-entrypoint-initdb.d/
COPY --chmod=0644 20-app-grants.sql /docker-entrypoint-initdb.d/
