FROM caddy:2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d

RUN addgroup -S app && adduser -S -D -H -G app app \
  && chown -R app:app /config /data /etc/caddy

COPY Caddyfile /etc/caddy/Caddyfile

USER app

EXPOSE 8080

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
