FROM node:22-alpine@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914
RUN apk add --no-cache openldap openldap-back-mdb openldap-clients ca-certificates
COPY apps/identity/ldap/entrypoint.sh /usr/local/bin/training-ldap
COPY infra/ldap/users.ldif /opt/training/users.ldif
RUN chmod +x /usr/local/bin/training-ldap
EXPOSE 1389
ENTRYPOINT ["/usr/local/bin/training-ldap"]
