#!/bin/sh
set -eu
prefix=${1:?Image prefix is required}
current=${2:?Current SHA tag is required}
previous=${3:-}
printf '%s\n' "$prefix" | grep -Eq '^ghcr\.io/[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*$' || exit 1
printf '%s\n' "$current" | grep -Eq '^sha-[a-f0-9]{40}$' || exit 1
if [ -n "$previous" ]; then
    printf '%s\n' "$previous" | grep -Eq '^sha-[a-f0-9]{40}$' || exit 1
fi
for service in service-desk migrate identity ldap provision postgres; do
    repository="$prefix-$service"
    images=$(docker image ls --filter "reference=$repository:sha-*" --format '{{.Repository}}:{{.Tag}}')
    for image in $images; do
        # Inspect the exact repository as well as the SHA tag before deleting.
        [ "${image%:*}" = "$repository" ] || continue
        tag=${image##*:}
        printf '%s\n' "$tag" | grep -Eq '^sha-[a-f0-9]{40}$' || continue
        [ "$tag" != "$current" ] || continue
        [ "$tag" != "$previous" ] || continue
        # No force: Docker protects images still referenced by any container.
        if ! docker image rm "$image"; then
            echo "Kept $image: Docker refused removal." >&2
        fi
    done
done
