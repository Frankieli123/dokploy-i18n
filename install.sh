#!/bin/bash

set -o pipefail

# Detect version from environment variable or default to latest
# Usage: DOKPLOY_VERSION=canary bash install.sh
# Usage: DOKPLOY_VERSION=feature bash install.sh
# Usage: bash install.sh (defaults to latest)
detect_version() {
    local version="${DOKPLOY_VERSION:-latest}"
    echo "$version"
}

# Function to detect if running in Proxmox LXC container
is_proxmox_lxc() {
    # Check for LXC in environment
    if [ -n "$container" ] && [ "$container" = "lxc" ]; then
        return 0  # LXC container
    fi
    
    # Check for LXC in /proc/1/environ
    if grep -q "container=lxc" /proc/1/environ 2>/dev/null; then
        return 0  # LXC container
    fi
    
    return 1  # Not LXC
}

install_dokploy() {
    # Detect version tag
    VERSION_TAG=$(detect_version)
    DOCKER_IMAGE="a3180623/dokploy-i18n:${VERSION_TAG}"
    
    echo "Installing Dokploy version: ${VERSION_TAG}"
    if [ "$(id -u)" != "0" ]; then
        echo "This script must be run as root" >&2
        exit 1
    fi

    # check if is Mac OS
    if [ "$(uname)" = "Darwin" ]; then
        echo "This script must be run on Linux" >&2
        exit 1
    fi

    # check if is running inside a container
    if [ -f /.dockerenv ]; then
        echo "This script must be run on Linux" >&2
        exit 1
    fi

    # check if something is running on port 80
    if ss -tulnp | grep ':80 ' >/dev/null; then
        echo "Error: something is already running on port 80" >&2
        exit 1
    fi

    # check if something is running on port 443
    if ss -tulnp | grep ':443 ' >/dev/null; then
        echo "Error: something is already running on port 443" >&2
        exit 1
    fi

    # check if something is running on port 3000
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

    if command_exists docker; then
      echo "Docker already installed"
    else
      if ! curl -fsSL https://get.docker.com | sh -s -- --version 28.5.0; then
        echo "Error: Docker installation failed" >&2
        exit 1
      fi
      if ! command_exists docker; then
        echo "Error: Docker installation did not provide the docker command" >&2
        exit 1
      fi
    fi

    # Check if running in Proxmox LXC container and set endpoint mode
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
        
        # Try IPv4 first
        # First attempt: ifconfig.io
        ip=$(curl -4s --connect-timeout 5 https://ifconfig.io 2>/dev/null)
        
        # Second attempt: icanhazip.com
        if [ -z "$ip" ]; then
            ip=$(curl -4s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
        fi
        
        # Third attempt: ipecho.net
        if [ -z "$ip" ]; then
            ip=$(curl -4s --connect-timeout 5 https://ipecho.net/plain 2>/dev/null)
        fi

        # If no IPv4, try IPv6
        if [ -z "$ip" ]; then
            # Try IPv6 with ifconfig.io
            ip=$(curl -6s --connect-timeout 5 https://ifconfig.io 2>/dev/null)
            
            # Try IPv6 with icanhazip.com
            if [ -z "$ip" ]; then
                ip=$(curl -6s --connect-timeout 5 https://icanhazip.com 2>/dev/null)
            fi
            
            # Try IPv6 with ipecho.net
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

    # Allow custom Docker Swarm init arguments via DOCKER_SWARM_INIT_ARGS environment variable
    # Example: export DOCKER_SWARM_INIT_ARGS="--default-addr-pool 172.20.0.0/16 --default-addr-pool-mask-length 24"
    # This is useful to avoid CIDR overlapping with cloud provider VPCs (e.g., AWS)
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

    mkdir -p /etc/dokploy

    chmod 777 /etc/dokploy

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

    # Installation
    # Set RELEASE_TAG environment variable for canary/feature versions
    release_tag_env=""
    if [ "$VERSION_TAG" != "latest" ]; then
        release_tag_env="-e RELEASE_TAG=$VERSION_TAG"
    fi
    
    docker service create \
      --name dokploy \
      --replicas 1 \
      --network dokploy-network \
      --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
      --mount type=bind,source=/etc/dokploy,target=/etc/dokploy \
      --mount type=volume,source=dokploy,target=/root/.docker \
      --publish published=3000,target=3000,mode=host \
      --update-parallelism 1 \
      --update-order stop-first \
      --constraint 'node.role == manager' \
      $endpoint_mode \
      $release_tag_env \
      -e ADVERTISE_ADDR=$advertise_addr \
      -e DOKPLOY_HOST_ETC_DIR=/etc/dokploy \
      "$DOCKER_IMAGE" || {
        echo "Error: failed to create Dokploy service" >&2
        exit 1
      }

    ensure_traefik /etc/dokploy || exit 1

    GREEN="\033[0;32m"
    YELLOW="\033[1;33m"
    BLUE="\033[0;34m"
    NC="\033[0m" # No Color

    format_ip_for_url() {
        local ip="$1"
        if echo "$ip" | grep -q ':'; then
            # IPv6
            echo "[${ip}]"
        else
            # IPv4
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
    # Detect version tag
    VERSION_TAG=$(detect_version)
    DOCKER_IMAGE="a3180623/dokploy-i18n:${VERSION_TAG}"
    
    echo "Updating Dokploy to version: ${VERSION_TAG}"
    
    # Pull the image
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
    release_tag_args+=(--env-add "DOKPLOY_HOST_ETC_DIR=/etc/dokploy")

    if ! docker service update --image "$DOCKER_IMAGE" "${release_tag_args[@]}" dokploy; then
        echo "Error: failed to update Dokploy service" >&2
        exit 1
    fi

    echo "Dokploy has been updated to version: ${VERSION_TAG}"
}

# Main script execution
if [ "$1" = "update" ]; then
    update_dokploy
else
    install_dokploy
fi
