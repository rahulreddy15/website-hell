# Path to Production

K8s is a production grade container orchestrator

Key Components

API Server
Primary interaction point for all k8s components and users.
API Serer delegates state to a backend which is commonly `etcd`

kubelet
The on host agent that communicates with the API server to report the status of a node and understand what workloads need to be scheduled on it.
Commuincated with the container runtime to ensure workloads for the node are started and healthy.

Controller Manager
A set of controllers that handle reconciliation of core K8s objects.
When a desired state is declared, ex: 3 replicas in a Deployment.
A controller within handles the creation of the new Pods to satisfy this state.

Scheduler
Decides where workloads should run based on choosing an optimal node.
It uses filtering and scoring to make this decision.

Kube Proxy
Implements k8s services that provide virtual IPs that can route to Pods.
This is done with a packet filtering mechanism like iptables or ipvs.

CNI - Container Networking Interface
CSI - Container Storage Interface
CRI - Container Runtime Interface
SMI - Service Mesh Interface
CPI - Cloud Provider Interface

The first chapter focused on the different ways and approaches for deploying using Kubernetes based on factors like development effort, team expertise, etc.
Choosing the right kind of Application Layer is essential for any team to succeed using Kubernetes.
Platforms like AWS, Heroku, and GCP offer tailor made k8s engines to deploy k8s clusters. This is the best solution for most people unless you need a tailaormade k8s application layer optimzied for your stack.
Also, k8s provides a lot of interfaces that are plug and play. The choice of what technology to use at these interfaces depends on the developers.
But the fact that there are interfaces makes K8s quite extensible with plugins that can add tons of functionality.