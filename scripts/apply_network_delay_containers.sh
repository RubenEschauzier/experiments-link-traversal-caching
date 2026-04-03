#!/bin/bash
# usage in a persistent terminal (e.g. tmux)
# sudo NETWORK_DELAY=40ms bash appl.sh
DELAY=${NETWORK_DELAY:-100ms}

echo "Watching for new containers, will apply ${DELAY} delay to their veth..."

docker events \
  --filter 'type=container' \
  --filter 'event=start' \
  --format '{{.Actor.ID}}' | while read container_id
do
    echo "Container started: ${container_id:0:12}"
    
    # Give the veth interface a moment to be provisioned
    sleep 1

    # Get the container's PID
    PID=$(docker inspect -f '{{.State.Pid}}' "$container_id" 2>/dev/null)
    if [ -z "$PID" ] || [ "$PID" = "0" ]; then
        echo "  Could not get PID, skipping"
        continue
    fi

    # Get the interface index of eth0 inside the container's netns
    INNER_IDX=$(nsenter -t "$PID" -n -- ip link show eth0 2>/dev/null \
        | awk -F': ' 'NR==1{print $1}')
    
    if [ -z "$INNER_IDX" ]; then
        echo "  Could not find eth0 inside container, skipping"
        continue
    fi

    # The host-side veth peer index is linked via the if_index
    # Find it by matching the link-netnsid peer
    PEER_IDX=$(nsenter -t "$PID" -n -- ip link show eth0 \
        | grep -oP '(?<=eth0@if)\d+')

    # Find the interface on the host with that index
    VETH=$(ip link show | awk -F': ' "/^${PEER_IDX}:/{print \$2}" | cut -d'@' -f1)

    if [ -z "$VETH" ]; then
        echo "  Could not find host veth peer, skipping"
        continue
    fi

    echo "  Container PID=$PID → host veth=$VETH"

    # Remove existing qdisc if any (ignore error if none)
    tc qdisc del dev "$VETH" root 2>/dev/null

    # Apply the delay
    if tc qdisc add dev "$VETH" root netem delay "$DELAY"; then
        echo "  Applied ${DELAY} delay to $VETH"
    else
        echo "  Failed to apply delay to $VETH"
    fi
done