import os

name = os.environ.get("PI_VM_TEMPLATE", "pi-template")

template = [
    (
        name,
        {
            "ssh_hostname": "orb",
            "ssh_user": f"root@{name}",
            "ssh_forward_agent": False,
        },
    ),
]
