#!/usr/bin/env sh
set -eu

# TASK-185 liveness gate: fail if Docker's post-DNAT ingress guard is absent.
pubif=$(ip route show default | awk '{print $5; exit}')
test -n "$pubif"
iptables -C DOCKER-USER -i "$pubif" -p tcp -m conntrack --ctorigdstport 30000:30999 -j DROP
ip6tables -C DOCKER-USER -i "$pubif" -p tcp -m conntrack --ctorigdstport 30000:30999 -j DROP
