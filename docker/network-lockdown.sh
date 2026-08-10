#!/usr/bin/env bash
set -euo pipefail

ipv4_private_ranges=(
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

# Fedora's default iptables wrapper selects the legacy backend, which OrbStack
# does not expose. Prefer the nft backend when the distribution provides it.
iptables_bin=iptables
ip6tables_bin=ip6tables
if [[ -x /usr/sbin/iptables-nft ]]; then
	iptables_bin=/usr/sbin/iptables-nft
elif [[ -x /usr/bin/iptables-nft ]]; then
	iptables_bin=/usr/bin/iptables-nft
fi
if [[ -x /usr/sbin/ip6tables-nft ]]; then
	ip6tables_bin=/usr/sbin/ip6tables-nft
elif [[ -x /usr/bin/ip6tables-nft ]]; then
	ip6tables_bin=/usr/bin/ip6tables-nft
fi

"$iptables_bin" -w -A OUTPUT -o lo -j ACCEPT
"$iptables_bin" -w -A OUTPUT -d 127.0.0.0/8 -j ACCEPT

# The launcher supplies the host's active LAN addresses. Permit only those
# exact addresses before rejecting RFC1918 ranges below.
is_ipv4() {
	local ip="$1" octet
	local -a octets
	IFS=. read -r -a octets <<< "$ip"
	[[ ${#octets[@]} -eq 4 ]] || return 1
	for octet in "${octets[@]}"; do
		[[ "$octet" =~ ^[0-9]{1,3}$ ]] && (( 10#$octet <= 255 )) || return 1
	done
}
IFS=, read -r -a host_lan_ips <<< "${PI_HOST_LAN_IPS:-}"
for host_lan_ip in "${host_lan_ips[@]}"; do
	if is_ipv4 "$host_lan_ip"; then
		"$iptables_bin" -w -A OUTPUT -d "$host_lan_ip" -j ACCEPT
	fi
done
unset IFS

while read -r resolver; do
	if [[ "$resolver" != *:* ]]; then
		"$iptables_bin" -w -A OUTPUT -d "$resolver" -p udp --dport 53 -j ACCEPT
		"$iptables_bin" -w -A OUTPUT -d "$resolver" -p tcp --dport 53 -j ACCEPT
	fi
done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)
for range in "${ipv4_private_ranges[@]}"; do
	"$iptables_bin" -w -A OUTPUT -d "$range" -j REJECT --reject-with icmp-net-unreachable
done

if "$ip6tables_bin" -w -L OUTPUT >/dev/null 2>&1; then
	"$ip6tables_bin" -w -A OUTPUT -o lo -j ACCEPT
	"$ip6tables_bin" -w -A OUTPUT -d ::1/128 -j ACCEPT
	while read -r resolver; do
		if [[ "$resolver" == *:* ]]; then
			"$ip6tables_bin" -w -A OUTPUT -d "$resolver" -p udp --dport 53 -j ACCEPT
			"$ip6tables_bin" -w -A OUTPUT -d "$resolver" -p tcp --dport 53 -j ACCEPT
		fi
	done < <(awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf)
	for range in fc00::/7 fe80::/10 ff00::/8; do
		"$ip6tables_bin" -w -A OUTPUT -d "$range" -j REJECT --reject-with icmp6-addr-unreachable
	done
fi
