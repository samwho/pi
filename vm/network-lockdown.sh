#!/usr/bin/env bash
set -euo pipefail

# Enforce this policy as root in the OrbStack machine, outside the unprivileged
# agent and its rootless Docker daemon. Public IPv4 and DNS remain available;
# local/private networks are blocked except for the explicitly configured Mac IP.
ipv4_blocked_ranges=(
  0.0.0.0/8
  10.0.0.0/8
  100.64.0.0/10
  169.254.0.0/16
  172.16.0.0/12
  192.168.0.0/16
  198.18.0.0/15
  224.0.0.0/4
  240.0.0.0/4
)

iptables_bin=iptables-nft
ip6tables_bin=ip6tables-nft
command -v "$iptables_bin" >/dev/null || iptables_bin=iptables
command -v "$ip6tables_bin" >/dev/null || ip6tables_bin=ip6tables

ensure_jump() {
  local binary="$1" chain="$2"
  "$binary" -w -N "$chain" 2>/dev/null || true
  "$binary" -w -F "$chain"
  "$binary" -w -C OUTPUT -j "$chain" 2>/dev/null || "$binary" -w -I OUTPUT 1 -j "$chain"
}

ensure_jump "$iptables_bin" PI_SANDBOX
"$iptables_bin" -w -A PI_SANDBOX -o lo -j ACCEPT
"$iptables_bin" -w -A PI_SANDBOX -d 127.0.0.0/8 -j ACCEPT

# The host launcher writes exactly one validated address before reloading this policy.
if [[ -r /etc/pi-sandbox/host-ip ]]; then
  host_ip="$(tr -d '[:space:]' </etc/pi-sandbox/host-ip)"
  if [[ "$host_ip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    "$iptables_bin" -w -A PI_SANDBOX -d "$host_ip"/32 -j ACCEPT
  fi
fi

# OrbStack's resolver is commonly in its 198.18.0.0/15 machine network. Permit
# only DNS to resolvers actually configured for this machine.
while read -r resolver; do
  [[ "$resolver" == *:* ]] && continue
  "$iptables_bin" -w -A PI_SANDBOX -d "$resolver" -p udp --dport 53 -j ACCEPT
  "$iptables_bin" -w -A PI_SANDBOX -d "$resolver" -p tcp --dport 53 -j ACCEPT
done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)

for range in "${ipv4_blocked_ranges[@]}"; do
  "$iptables_bin" -w -A PI_SANDBOX -d "$range" -j REJECT --reject-with icmp-net-unreachable
done
"$iptables_bin" -w -A PI_SANDBOX -j RETURN

# Globally addressed IPv6 LAN hosts cannot be distinguished from public IPv6
# destinations by prefix alone. Disable IPv6 egress rather than leave that bypass.
if "$ip6tables_bin" -w -L OUTPUT >/dev/null 2>&1; then
  ensure_jump "$ip6tables_bin" PI_SANDBOX
  "$ip6tables_bin" -w -A PI_SANDBOX -o lo -j ACCEPT
  "$ip6tables_bin" -w -A PI_SANDBOX -d ::1/128 -j ACCEPT
  "$ip6tables_bin" -w -A PI_SANDBOX -j REJECT --reject-with icmp6-addr-unreachable
fi
