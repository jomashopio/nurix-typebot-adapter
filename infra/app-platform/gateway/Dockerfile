FROM caddy:2.11.3-alpine@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794

RUN addgroup -S app && adduser -S -D -H -G app app \
  && chown -R app:app /config /data /etc/caddy

COPY infra/app-platform/gateway/Caddyfile /etc/caddy/Caddyfile

USER app

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
