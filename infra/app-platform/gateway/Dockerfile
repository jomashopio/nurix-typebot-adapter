FROM caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648

RUN addgroup -S app && adduser -S -D -H -G app app \
  && chown -R app:app /config /data /etc/caddy

COPY infra/app-platform/gateway/Caddyfile /etc/caddy/Caddyfile

USER app

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
