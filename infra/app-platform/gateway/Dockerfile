FROM caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f

RUN addgroup -S app && adduser -S -D -H -G app app \
  && chown -R app:app /config /data /etc/caddy

COPY infra/app-platform/gateway/Caddyfile /etc/caddy/Caddyfile

USER app

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
