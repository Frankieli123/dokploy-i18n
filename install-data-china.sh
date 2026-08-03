#!/bin/bash

set -o pipefail

# Install Dokploy with all persistent data under /data by default (China mirrors).
# Usage: DOKPLOY_VERSION=canary bash install-data-china.sh
# Usage: DOKPLOY_VERSION=feature bash install-data-china.sh
# Usage: bash install-data-china.sh (defaults to latest)
#
# Paths:
# - DOKPLOY_DATA_DIR (default: /data)
# - DOKPLOY_ETC_DIR  (default: $DOKPLOY_DATA_DIR/dokploy)
# - DOCKER_DATA_ROOT (default: $DOKPLOY_DATA_DIR/docker)
# - FORCE_DOCKER_DATA_ROOT_CHANGE=1 to override safety exit when Docker already has state

detect_version() {
    local version="${DOKPLOY_VERSION:-latest}"
    echo "$version"
}

is_proxmox_lxc() {
    if [ -n "$container" ] && [ "$container" = "lxc" ]; then
        return 0
    fi

    if grep -q "container=lxc" /proc/1/environ 2>/dev/null; then
        return 0
    fi

    return 1
}

install_dokploy() {
    VERSION_TAG=$(detect_version)
    DOCKER_IMAGE="a3180623/dokploy-i18n:${VERSION_TAG}"

    data_dir="${DOKPLOY_DATA_DIR:-/data}"
    dokploy_dir="${DOKPLOY_ETC_DIR:-${data_dir%/}/dokploy}"
    docker_data_root="${DOCKER_DATA_ROOT:-${data_dir%/}/docker}"

    echo "Installing Dokploy version: ${VERSION_TAG}"
    echo "Using DOKPLOY dir: ${dokploy_dir}"
    echo "Using Docker data-root: ${docker_data_root}"

    if [ "$(id -u)" != "0" ]; then
        echo "This script must be run as root" >&2
        exit 1
    fi

    if [ "$(uname)" = "Darwin" ]; then
        echo "This script must be run on Linux" >&2
        exit 1
    fi

    if [ -f /.dockerenv ]; then
        echo "This script must be run on Linux" >&2
        exit 1
    fi

    if ss -tulnp | grep ':80 ' >/dev/null; then
        echo "Error: something is already running on port 80" >&2
        exit 1
    fi

    if ss -tulnp | grep ':443 ' >/dev/null; then
        echo "Error: something is already running on port 443" >&2
        exit 1
    fi

    if ss -tulnp | grep ':3000 ' >/dev/null; then
        echo "Error: something is already running on port 3000" >&2
        echo "Dokploy requires port 3000 to be available. Please stop any service using this port." >&2
        exit 1
    fi

    command_exists() {
      command -v "$@" > /dev/null 2>&1
    }

    ensure_traefik() {
        local dokploy_root="$1"
        local traefik_dir="${dokploy_root%/}/traefik"
        local main_config="$traefik_dir/traefik.yml"
        local dynamic_dir="$traefik_dir/dynamic"
        local timeout="${TRAEFIK_INSTALL_TIMEOUT:-180}"
        local waited=0
        local traefik_image="traefik:v${TRAEFIK_VERSION:-3.6.1}"
        case "$timeout" in
            ''|*[!0-9]*)
                echo "Error: TRAEFIK_INSTALL_TIMEOUT must be a non-negative integer" >&2
                return 1
                ;;
        esac

        mkdir -p "$dynamic_dir"
        echo "Waiting for Dokploy to prepare the Traefik configuration..."

        while [ ! -s "$main_config" ]; do
            if ! docker service inspect dokploy >/dev/null 2>&1; then
                echo "Error: Dokploy service was not created" >&2
                return 1
            fi
            if [ "$waited" -ge "$timeout" ]; then
                echo "Error: timed out waiting for $main_config" >&2
                docker service logs --raw --tail 100 dokploy 2>&1 || true
                return 1
            fi
            sleep 2
            waited=$((waited + 2))
        done

        if docker inspect dokploy-traefik >/dev/null 2>&1; then
            local current_main_source
            local current_dynamic_source
            current_main_source="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/traefik/traefik.yml"}}{{.Source}}{{end}}{{end}}' dokploy-traefik 2>/dev/null || true)"
            current_dynamic_source="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/dokploy/traefik/dynamic"}}{{.Source}}{{end}}{{end}}' dokploy-traefik 2>/dev/null || true)"
            if [ "$current_main_source" != "$main_config" ] || [ "$current_dynamic_source" != "$dynamic_dir" ]; then
                echo "Recreating Traefik with the correct host data paths"
                if ! docker rm -f dokploy-traefik >/dev/null; then
                    echo "Error: failed to remove the incorrectly mounted Traefik container" >&2
                    return 1
                fi
            fi
        fi

        if docker inspect dokploy-traefik >/dev/null 2>&1; then
            echo "Traefik container already exists"
            waited=0
            while [ "$(docker inspect -f '{{.State.Running}}' dokploy-traefik 2>/dev/null || true)" != "true" ] && [ "$waited" -lt 10 ]; do
                sleep 1
                waited=$((waited + 1))
            done
            if [ "$(docker inspect -f '{{.State.Running}}' dokploy-traefik 2>/dev/null || true)" != "true" ]; then
                if ! docker start dokploy-traefik >/dev/null; then
                    echo "Error: failed to start the existing Traefik container" >&2
                    docker logs --tail 100 dokploy-traefik 2>&1 || true
                    return 1
                fi
            fi
        else
            if ! docker pull "$traefik_image"; then
                echo "Error: failed to pull $traefik_image" >&2
                return 1
            fi
            if ! docker run -d \
                --name dokploy-traefik \
                --restart always \
                -v "$main_config:/etc/traefik/traefik.yml" \
                -v "$dynamic_dir:/etc/dokploy/traefik/dynamic" \
                -v /var/run/docker.sock:/var/run/docker.sock:ro \
                -p 80:80/tcp \
                -p 443:443/tcp \
                -p 443:443/udp \
                "$traefik_image"; then
                echo "Error: failed to create the Traefik container" >&2
                return 1
            fi
        fi

        if ! docker inspect -f '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}' dokploy-traefik 2>/dev/null | grep -Fxq dokploy-network; then
            if ! docker network connect dokploy-network dokploy-traefik; then
                echo "Error: failed to connect Traefik to dokploy-network" >&2
                return 1
            fi
        fi

        waited=0
        while [ "$(docker inspect -f '{{.State.Running}}' dokploy-traefik 2>/dev/null || true)" != "true" ]; do
            if [ "$waited" -ge 20 ]; then
                echo "Error: Traefik did not remain running" >&2
                docker logs --tail 100 dokploy-traefik 2>&1 || true
                return 1
            fi
            sleep 1
            waited=$((waited + 1))
        done

        if [ -z "$(docker port dokploy-traefik 80/tcp 2>/dev/null || true)" ] || [ -z "$(docker port dokploy-traefik 443/tcp 2>/dev/null || true)" ]; then
            echo "Error: Traefik is not publishing ports 80 and 443" >&2
            docker logs --tail 100 dokploy-traefik 2>&1 || true
            return 1
        fi

        echo "Traefik is ready"
    }

    restart_docker() {
        if command_exists systemctl; then
            systemctl daemon-reload >/dev/null 2>&1 || true
            systemctl restart docker
        elif command_exists service; then
            service docker restart
        else
            echo "Warning: couldn't restart docker (no systemctl/service). Restart it manually if needed." >&2
        fi
    }

    configure_docker_daemon_json() {
        mkdir -p "$docker_data_root"

        local daemon_dir="/etc/docker"
        local daemon_json="${daemon_dir}/daemon.json"
        mkdir -p "$daemon_dir"

        write_daemon_json() {
            cat > "$daemon_json" <<EOF
{
  "data-root": "${docker_data_root}",
  "registry-mirrors": [
    "https://docker.1ms.run",
    "https://dockerproxy.net",
    "https://docker.m.daocloud.io",
    "https://docker.1panel.live"
  ]
}
EOF
        }

        if command_exists docker; then
            local current_root
            current_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
            if [ -n "$current_root" ] && [ "$current_root" != "$docker_data_root" ]; then
                local state_count="0"
                state_count="$(( $(docker ps -aq 2>/dev/null | wc -l 2>/dev/null || echo 0) + $(docker image ls -aq 2>/dev/null | wc -l 2>/dev/null || echo 0) + $(docker volume ls -q 2>/dev/null | wc -l 2>/dev/null || echo 0) ))"
                if [ "${FORCE_DOCKER_DATA_ROOT_CHANGE:-}" != "1" ] && [ "$state_count" != "0" ]; then
                    echo "Error: Docker already has state under: $current_root" >&2
                    echo "Refusing to change Docker data-root automatically because it may orphan existing containers/images/volumes." >&2
                    echo "To force (at your own risk): export FORCE_DOCKER_DATA_ROOT_CHANGE=1" >&2
                    exit 1
                fi
            fi
        fi

        if [ ! -f "$daemon_json" ]; then
            write_daemon_json
        else
            if grep -q '^[[:space:]]*{[[:space:]]*}[[:space:]]*$' "$daemon_json" 2>/dev/null; then
                write_daemon_json
            elif command_exists jq; then
                local tmp_file
                tmp_file="$(mktemp)"
                if ! jq --arg data_root "$docker_data_root" '.["data-root"]=$data_root | .["registry-mirrors"]=[
                  "https://docker.1ms.run",
                  "https://dockerproxy.net",
                  "https://docker.m.daocloud.io",
                  "https://docker.1panel.live"
                ]' "$daemon_json" > "$tmp_file"; then
                    rm -f "$tmp_file" 2>/dev/null || true
                    local backup="${daemon_json}.bak.$(date +%s)"
                    cp "$daemon_json" "$backup" 2>/dev/null || true
                    echo "Error: failed to update $daemon_json using jq (invalid JSON?)." >&2
                    echo "Backed up to: $backup" >&2
                    exit 1
                fi
                mv "$tmp_file" "$daemon_json"
            else
                local other_key=""
                other_key="$(grep -oE '"[^"]+"[[:space:]]*:' "$daemon_json" 2>/dev/null | sed -E 's/"([^"]+)".*/\1/' | grep -vE '^(data-root|registry-mirrors)$' | head -n1 || true)"
                if [ -n "$other_key" ]; then
                    local backup="${daemon_json}.bak.$(date +%s)"
                    cp "$daemon_json" "$backup" 2>/dev/null || true
                    echo "Error: $daemon_json has other settings (e.g. \"$other_key\") and jq is not installed; refusing to overwrite." >&2
                    echo "Backed up to: $backup" >&2
                    echo "Please install jq or update $daemon_json manually to set:" >&2
                    echo "  data-root: $docker_data_root" >&2
                    echo "  registry-mirrors: https://docker.1ms.run https://dockerproxy.net https://docker.m.daocloud.io https://docker.1panel.live" >&2
                    exit 1
                fi
                write_daemon_json
            fi
        fi

        restart_docker

        if command_exists docker; then
            local new_root
            new_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || true)"
            if [ -n "$new_root" ] && [ "$new_root" != "$docker_data_root" ]; then
                echo "Error: Docker Root Dir is still: $new_root (expected: $docker_data_root)" >&2
                echo "Please restart Docker manually and re-run, or check $daemon_json." >&2
                exit 1
            fi
        fi
    }

    if command_exists docker; then
      echo "Docker already installed"
    else
      docker_ce_source="${DOCKER_CE_SOURCE:-mirrors.aliyun.com/docker-ce}"
      docker_ce_codename="${DOCKER_CE_CODENAME:-}"
      if [ -z "$docker_ce_codename" ] && [ -r /etc/os-release ]; then
        . /etc/os-release
        if [ "${ID:-}" = "debian" ] && [ "${VERSION_CODENAME:-}" = "trixie" ]; then
          docker_ce_codename="bookworm"
        fi
      fi
      if [ -n "$docker_ce_codename" ]; then
        if ! curl -fsSL https://linuxmirrors.cn/docker.sh | bash -s -- --source "$docker_ce_source" --protocol https --use-intranet-source false --codename "$docker_ce_codename" --designated-version 28.5.0 --ignore-backup-tips --pure-mode; then
          echo "Error: Docker installation failed" >&2
          exit 1
        fi
      else
        if ! curl -fsSL https://linuxmirrors.cn/docker.sh | bash -s -- --source "$docker_ce_source" --protocol https --use-intranet-source false --designated-version 28.5.0 --ignore-backup-tips --pure-mode; then
          echo "Error: Docker installation failed" >&2
          exit 1
        fi
      fi

      if ! command_exists docker; then
        echo "Error: Docker installation failed" >&2
        exit 1
      fi
    fi

    configure_docker_daemon_json

    endpoint_mode=""
    if is_proxmox_lxc; then
        echo " WARNING: Detected Proxmox LXC container environment!"
        echo "Adding --endpoint-mode dnsrr to Docker service for LXC compatibility."
        echo "This may affect service discovery but is required for LXC containers."
        echo ""
        endpoint_mode="--endpoint-mode dnsrr"
        echo "Waiting for 5 seconds before continuing..."
        sleep 5
    fi

    docker swarm leave --force 2>/dev/null

    get_ip() {
        local ip=""
        ip=$(curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null)
        if [ -z "$ip" ]; then
            ip=$(curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
        fi
        if [ -z "$ip" ]; then
            ip=$(curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
        fi

        if [ -z "$ip" ]; then
            ip=$(curl -6s --connect-timeout 5 https://ifconfig.io 2>/dev/null)
            if [ -z "$ip" ]; then
                ip=$(curl -6s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
            fi
            if [ -z "$ip" ]; then
                ip=$(curl -6s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
            fi
        fi

        if [ -z "$ip" ]; then
            echo "Error: Could not determine server IP address automatically (neither IPv4 nor IPv6)." >&2
            echo "Please set the ADVERTISE_ADDR environment variable manually." >&2
            echo "Example: export ADVERTISE_ADDR=<your-server-ip>" >&2
            exit 1
        fi

        echo "$ip"
    }

    get_private_ip() {
        ip addr show | grep -E "inet (192\.168\.|10\.|172\.1[6-9]\.|172\.2[0-9]\.|172\.3[0-1]\.)" | head -n1 | awk '{print $2}' | cut -d/ -f1
    }

    advertise_addr="${ADVERTISE_ADDR:-$(get_private_ip)}"

    if [ -z "$advertise_addr" ]; then
        echo "ERROR: We couldn't find a private IP address."
        echo "Please set the ADVERTISE_ADDR environment variable manually."
        echo "Example: export ADVERTISE_ADDR=192.168.1.100"
        exit 1
    fi
    echo "Using advertise address: $advertise_addr"

    swarm_init_args="${DOCKER_SWARM_INIT_ARGS:-}"

    if [ -n "$swarm_init_args" ]; then
        echo "Using custom swarm init arguments: $swarm_init_args"
        docker swarm init --advertise-addr $advertise_addr $swarm_init_args
    else
        docker swarm init --advertise-addr $advertise_addr
    fi

    if [ $? -ne 0 ]; then
        echo "Error: Failed to initialize Docker Swarm" >&2
        exit 1
    fi

    echo "Swarm initialized"

    docker network rm -f dokploy-network 2>/dev/null
    docker network create --driver overlay --attachable dokploy-network || {
        echo "Error: failed to create dokploy-network" >&2
        exit 1
    }

    echo "Network created"

    mkdir -p "$dokploy_dir"
    chmod 777 "$dokploy_dir"

    AUTH_SECRET_DIR="$dokploy_dir/secrets"
    AUTH_SECRET_FILE="$AUTH_SECRET_DIR/better-auth-secret"
    mkdir -p "$AUTH_SECRET_DIR"
    chmod 700 "$AUTH_SECRET_DIR"
    if [ ! -s "$AUTH_SECRET_FILE" ]; then
        (umask 077 && head -c 48 /dev/urandom | base64 | tr -d '\n' > "$AUTH_SECRET_FILE") || {
            echo "Error: failed to create Dokploy auth secret" >&2
            exit 1
        }
    fi
    chmod 600 "$AUTH_SECRET_FILE"

    docker service create \
    --name dokploy-postgres \
    --constraint 'node.role==manager' \
    --network dokploy-network \
    --env POSTGRES_USER=dokploy \
    --env POSTGRES_DB=dokploy \
    --env POSTGRES_PASSWORD=amukds4wi9001583845717ad2 \
    --mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
    pgvector/pgvector:pg16 || {
        echo "Error: failed to create dokploy-postgres" >&2
        exit 1
    }

    docker service create \
    --name dokploy-redis \
    --constraint 'node.role==manager' \
    --network dokploy-network \
    --mount type=volume,source=dokploy-redis,target=/data \
    redis:7 || {
        echo "Error: failed to create dokploy-redis" >&2
        exit 1
    }

    release_tag_env=""
    if [ "$VERSION_TAG" != "latest" ]; then
        release_tag_env="-e RELEASE_TAG=$VERSION_TAG"
    fi

    docker service create \
      --name dokploy \
      --replicas 1 \
      --network dokploy-network \
      --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
      --mount type=bind,source="$dokploy_dir",target=/etc/dokploy \
      --mount type=volume,source=dokploy,target=/root/.docker \
      --publish published=3000,target=3000,mode=host \
      --update-parallelism 1 \
      --update-order stop-first \
      --constraint 'node.role == manager' \
      $endpoint_mode \
      $release_tag_env \
      -e ADVERTISE_ADDR=$advertise_addr \
      -e "DOKPLOY_HOST_ETC_DIR=$dokploy_dir" \
      -e BETTER_AUTH_SECRET_FILE=/etc/dokploy/secrets/better-auth-secret \
      "$DOCKER_IMAGE" || {
        echo "Error: failed to create Dokploy service" >&2
        exit 1
      }

    ensure_traefik "$dokploy_dir" || exit 1

    GREEN="\033[0;32m"
    YELLOW="\033[1;33m"
    BLUE="\033[0;34m"
    NC="\033[0m"

    format_ip_for_url() {
        local ip="$1"
        if echo "$ip" | grep -q ':'; then
            echo "[${ip}]"
        else
            echo "${ip}"
        fi
    }

    public_ip="${ADVERTISE_ADDR:-$(get_ip)}"
    formatted_addr=$(format_ip_for_url "$public_ip")
    echo ""
    printf "${GREEN}Congratulations, Dokploy is installed!${NC}\n"
    printf "${BLUE}Wait 15 seconds for the server to start${NC}\n"
    printf "${YELLOW}Please go to http://${formatted_addr}:3000${NC}\n\n"
}

update_dokploy() {
    VERSION_TAG=$(detect_version)
    DOCKER_IMAGE="a3180623/dokploy-i18n:${VERSION_TAG}"
    data_dir="${DOKPLOY_DATA_DIR:-/data}"
    dokploy_dir="${DOKPLOY_ETC_DIR:-${data_dir%/}/dokploy}"

    echo "Updating Dokploy to version: ${VERSION_TAG}"

    if ! docker pull "$DOCKER_IMAGE"; then
        echo "Error: failed to pull $DOCKER_IMAGE" >&2
        exit 1
    fi

    release_tag_args=()
    if docker service inspect dokploy --format '{{range .Spec.TaskTemplate.ContainerSpec.Env}}{{println .}}{{end}}' 2>/dev/null | grep -q '^RELEASE_TAG='; then
        release_tag_args+=(--env-rm RELEASE_TAG)
    fi
    if [ "$VERSION_TAG" != "latest" ]; then
        release_tag_args+=(--env-add "RELEASE_TAG=$VERSION_TAG")
    fi
    release_tag_args+=(--env-add "DOKPLOY_HOST_ETC_DIR=$dokploy_dir")

    if ! docker service update --image "$DOCKER_IMAGE" "${release_tag_args[@]}" dokploy; then
        echo "Error: failed to update Dokploy service" >&2
        exit 1
    fi

    echo "Dokploy has been updated to version: ${VERSION_TAG}"
}

if [ "$1" = "update" ]; then
    update_dokploy
else
    install_dokploy
fi
