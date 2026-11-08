FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS theme
WORKDIR /build
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/identity/theme ./apps/identity/theme
COPY libs/theme ./libs/theme
COPY libs/ui ./libs/ui
COPY tools/build-identity-theme.mjs ./tools/build-identity-theme.mjs
RUN node tools/build-identity-theme.mjs

FROM quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13 AS keycloak-build
ENV KC_DB=postgres KC_HEALTH_ENABLED=true
RUN /opt/keycloak/bin/kc.sh build

FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS provision
WORKDIR /app
COPY tools/configure-identity.mjs tools/configure-access-model.mjs tools/configure-directory-client.mjs tools/configure-support-lead.mjs tools/rename-support-login.mjs tools/rename-support-role.mjs ./tools/
USER node
ENTRYPOINT ["node", "tools/configure-identity.mjs"]

FROM quay.io/keycloak/keycloak:26.7.0@sha256:0f198be292568439d700cdbfb893e69a6009bb43a94a06a945b1d3d506c76b13 AS runtime
COPY --from=keycloak-build /opt/keycloak/ /opt/keycloak/
COPY --chown=keycloak:keycloak --from=theme /build/dist/apps/identity/theme/artsofte /opt/keycloak/themes/artsofte
COPY --chown=keycloak:keycloak apps/identity/realm/training-realm.json /opt/keycloak/data/import/training-realm.json
ENV KC_DB=postgres KC_HEALTH_ENABLED=true
EXPOSE 8080
ENTRYPOINT ["/opt/keycloak/bin/kc.sh"]
CMD ["start", "--optimized", "--import-realm", "--http-enabled=true"]
