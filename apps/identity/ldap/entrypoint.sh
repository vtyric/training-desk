#!/bin/sh
set -eu
umask 077
: "${LDAP_ADMIN_PASSWORD:?Missing LDAP_ADMIN_PASSWORD}"
mkdir -p /var/lib/ldap /run/slapd
ADMIN_HASH=$(slappasswd -s "$LDAP_ADMIN_PASSWORD")
cat > /run/slapd/training.conf <<EOF
include /etc/openldap/schema/core.schema
include /etc/openldap/schema/cosine.schema
include /etc/openldap/schema/inetorgperson.schema
pidfile /run/slapd/slapd.pid
argsfile /run/slapd/slapd.args
modulepath /usr/lib/openldap
moduleload back_mdb
database mdb
maxsize 1073741824
suffix "dc=training,dc=local"
rootdn "cn=admin,dc=training,dc=local"
rootpw $ADMIN_HASH
directory /var/lib/ldap
index objectClass eq
index uid eq
access to attrs=userPassword
  by self write
  by anonymous auth
  by * none
access to *
  by self read
  by * none
EOF
if [ ! -f /var/lib/ldap/data.mdb ]; then
    cp /opt/training/users.ldif /run/slapd/users.ldif
    for NAME in ALICE SUPPORT DENIED; do
        eval "PASSWORD=\${LDAP_${NAME}_PASSWORD:?Missing LDAP_${NAME}_PASSWORD}"
        HASH=$(slappasswd -s "$PASSWORD")
        sed -i "s|__${NAME}_PASSWORD_HASH__|$HASH|g" /run/slapd/users.ldif
    done
    slapadd -f /run/slapd/training.conf -l /run/slapd/users.ldif
    rm /run/slapd/users.ldif
fi
exec slapd -f /run/slapd/training.conf -h ldap://0.0.0.0:1389 -d 256
