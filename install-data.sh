#!/bin/bash

# Install Dokploy with all persistent data under /data by default.
# Usage: DOKPLOY_VERSION=canary bash install-data
# Usage: DOKPLOY_VERSION=feature bash install-data
# Usage: bash install-data (defaults to latest)
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

    configure_docker_data_root() {
        mkdir -p "$docker_data_root"

        local daemon_dir="/etc/docker"
        local daemon_json="${daemon_dir}/daemon.json"
        mkdir -p "$daemon_dir"

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
            cat > "$daemon_json" <<EOF
{
  "data-root": "${docker_data_root}"
}
EOF
        else
            if command_exists jq; then
                local tmp_file
                tmp_file="$(mktemp)"
                jq --arg data_root "$docker_data_root" '.["data-root"]=$data_root' "$daemon_json" > "$tmp_file" && mv "$tmp_file" "$daemon_json"
            else
                if grep -q '"data-root"' "$daemon_json" 2>/dev/null; then
                    local existing_root
                    existing_root="$(sed -n 's/.*"data-root"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$daemon_json" | head -n1)"
                    if [ -n "$existing_root" ] && [ "$existing_root" != "$docker_data_root" ]; then
                        sed -i 's#"data-root"[[:space:]]*:[[:space:]]*"[^"]*"#"data-root": "'"$docker_data_root"'"#' "$daemon_json" 2>/dev/null || true
                    fi
                else
                    if grep -q '^[[:space:]]*{[[:space:]]*}[[:space:]]*$' "$daemon_json" 2>/dev/null; then
                        cat > "$daemon_json" <<EOF
{
  "data-root": "${docker_data_root}"
}
EOF
                    else
                        local backup="${daemon_json}.bak.$(date +%s)"
                        cp "$daemon_json" "$backup" 2>/dev/null || true
                        echo "Error: $daemon_json exists and jq is not installed; refusing to overwrite complex config." >&2
                        echo "Backed up to: $backup" >&2
                        echo "Please set Docker data-root manually to: $docker_data_root" >&2
                        exit 1
                    fi
                fi
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
      curl -sSL https://get.docker.com | sh -s -- --version 28.5.0
    fi

    configure_docker_data_root

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
    docker network create --driver overlay --attachable dokploy-network

    echo "Network created"

    mkdir -p "$dokploy_dir"
    chmod 777 "$dokploy_dir"

    docker service create \
    --name dokploy-postgres \
    --constraint 'node.role==manager' \
    --network dokploy-network \
    --env POSTGRES_USER=dokploy \
    --env POSTGRES_DB=dokploy \
    --env POSTGRES_PASSWORD=amukds4wi9001583845717ad2 \
    --mount type=volume,source=dokploy-postgres,target=/var/lib/postgresql/data \
    pgvector/pgvector:pg16

    docker service create \
    --name dokploy-redis \
    --constraint 'node.role==manager' \
    --network dokploy-network \
    --mount type=volume,source=dokploy-redis,target=/data \
    redis:7

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
      $DOCKER_IMAGE

    sleep 4

    mkdir -p "$dokploy_dir/traefik/dynamic"
    if [ ! -f "$dokploy_dir/traefik/traefik.yml" ]; then
        touch "$dokploy_dir/traefik/traefik.yml"
    fi

    docker run -d \
        --name dokploy-traefik \
        --restart always \
        -v "$dokploy_dir/traefik/traefik.yml:/etc/traefik/traefik.yml" \
        -v "$dokploy_dir/traefik/dynamic:/etc/dokploy/traefik/dynamic" \
        -v /var/run/docker.sock:/var/run/docker.sock:ro \
        -p 80:80/tcp \
        -p 443:443/tcp \
        -p 443:443/udp \
        traefik:v3.6.1

    docker network connect dokploy-network dokploy-traefik

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

    echo "Updating Dokploy to version: ${VERSION_TAG}"

    docker pull $DOCKER_IMAGE
    docker service update --image $DOCKER_IMAGE dokploy

    echo "Dokploy has been updated to version: ${VERSION_TAG}"
}

if [ "$1" = "update" ]; then
    update_dokploy
else
    install_dokploy
fi
