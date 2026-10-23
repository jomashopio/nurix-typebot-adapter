FROM caddy:2.11.6-alpine@sha256:d44355d3c2149dc580ce2cac735955d1c08d3d00882c30489c241aa51a5c10d9

RUN addgroup -S app && adduser -S -D -H -G app app \
  && chown -R app:app /config /data /etc/caddy

COPY infra/app-platform/gateway/Caddyfile /etc/caddy/Caddyfile

USER app

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
