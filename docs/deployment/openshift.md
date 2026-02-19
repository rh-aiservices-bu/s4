# OpenShift Deployment

Guide for deploying S4 on Red Hat OpenShift.

## Overview

S4 can be deployed to OpenShift using **Helm charts** (recommended) or standard Kubernetes manifests with OpenShift-specific enhancements:

- Routes instead of Ingress for external access
- Security Context Constraints (SCC)
- OpenShift-specific storage classes
- Integration with OpenShift console
- Optional: OpenShift Templates

## Prerequisites

- OpenShift 4.x cluster
- Helm 3.x (for Helm deployment)
- `oc` CLI tool
- Project/Namespace with sufficient quota
- At least 2GB RAM per pod
- 10GB persistent storage

## Quick Start (Helm - Recommended)

```bash
# Login to OpenShift
oc login https://api.your-cluster.com:6443

# Create project
oc new-project s4

# Deploy using Helm with Route enabled (auth required by default)
helm install s4 ./charts/s4 --namespace s4 \
  --set route.enabled=true \
  --set auth.username=admin \
  --set auth.password=your-secure-password

# Get Route URL
oc get route s4 -o jsonpath='{.spec.host}'
```

## Quick Start (Raw Manifests)

```bash
# Login to OpenShift
oc login https://api.your-cluster.com:6443

# Create project
oc new-project s4

# Deploy using Kubernetes manifests
oc apply -f kubernetes/

# Create Route for external access
oc expose svc/s4 --port=5000

# Get Route URL
oc get route s4
```

## Helm Deployment (Recommended)

> **Note:** Authentication is enabled by default. All installation examples require `--set auth.username=... --set auth.password=...` unless `--set auth.enabled=false` is specified.

### Basic Deployment with Route

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set route.enabled=true \
  --set auth.username=admin \
  --set auth.password=your-secure-password
```

### Without Authentication

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set route.enabled=true \
  --set auth.enabled=false
```

### With Custom Route Hostname

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set route.enabled=true \
  --set auth.username=admin \
  --set auth.password=your-secure-password \
  --set route.host=s4.apps.your-cluster.com
```

### With ODF Storage

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set route.enabled=true \
  --set auth.username=admin \
  --set auth.password=your-secure-password \
  --set storage.data.storageClass=ocs-storagecluster-ceph-rbd \
  --set storage.localStorage.storageClass=ocs-storagecluster-ceph-rbd
```

### Production Example

```yaml
# openshift-values.yaml
route:
  enabled: true
  host: s4.apps.example.com
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect

auth:
  enabled: true
  username: admin
  password: your-secure-password
  jwtSecret: your-random-secret-min-32-chars

storage:
  data:
    size: 100Gi
    storageClass: ocs-storagecluster-ceph-rbd
  localStorage:
    size: 500Gi
    storageClass: ocs-storagecluster-ceph-rbd

resources:
  requests:
    cpu: 500m
    memory: 1Gi
  limits:
    cpu: 2000m
    memory: 4Gi
```

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace -f openshift-values.yaml
```

---

## Using OpenShift CLI (`oc`)

### Project Setup

```bash
# Create project
oc new-project s4 --display-name="S4 Storage Service"

# Set project labels
oc label namespace s4 app=s4

# Grant permissions (if needed)
oc policy add-role-to-user edit <username> -n s4
```

### Deploy from Manifests (Legacy)
> **Note:** Authentication is enabled by default.

```bash
# Deploy all resources
oc apply -f kubernetes/

# Check deployment
oc get all -l app=s4

# View status in console
# Navigate to: Administrator -> Workloads -> Deployments -> s4
```

## OpenShift-Specific Resources

### Routes (External Access)

Routes provide external HTTPS access with automatic TLS termination. By default, only the **Web UI** (port 5000) is exposed via Route. The **S3 API** (port 7480) can optionally be exposed via a separate Route.

#### Web UI Route

```yaml
# route.yaml
apiVersion: route.openshift.io/v1
kind: Route
metadata:
  name: s4
  labels:
    app: s4
spec:
  port:
    targetPort: web-ui
  tls:
    termination: edge
    insecureEdgeTerminationPolicy: Redirect
  to:
    kind: Service
    name: s4
    weight: 100
  wildcardPolicy: None
```

```bash
# Create Route
oc create -f route.yaml

# Or expose service directly
oc expose svc/s4 --port=5000

# Enable TLS
oc patch route s4 -p '{"spec":{"tls":{"termination":"edge","insecureEdgeTerminationPolicy":"Redirect"}}}'

# Get Route URL
oc get route s4 -o jsonpath='{.spec.host}'

# Access S4
open https://$(oc get route s4 -o jsonpath='{.spec.host}')
```

#### Custom Route Hostname

```bash
# Create Route with custom hostname
oc create route edge s4 \
  --service=s4 \
  --hostname=s4.apps.your-cluster.com \
  --port=5000
```

#### S3 API Route (Optional)

To expose the S3 API externally for use with `aws s3`, `mc`, or other S3 clients, create a separate Route:

With Helm:

```bash
helm install s4 ./charts/s4 --namespace s4 --create-namespace \
  --set auth.username=admin \
  --set auth.password=your-secure-password \
  --set route.enabled=true \
  --set route.s3Api.enabled=true \
  --set route.s3Api.host=s3.s4.apps.your-cluster.com
```

With raw manifests:

```bash
oc apply -f kubernetes/s4-route-s3.yaml
```

Or create manually:

```bash
oc create route edge s4-api \
  --service=s4 \
  --hostname=s3.s4.apps.your-cluster.com \
  --port=7480
```

> **Warning:** Exposing the S3 API externally has security implications. Ensure proper authentication and network policies are in place.

### Security Context Constraints (SCC)

S4 runs as non-root and is compatible with the `restricted` SCC by default. No special SCC required.

Verify SCC:

```bash
# Check pod SCC
oc describe pod -l app=s4 | grep scc

# Should show: restricted or restricted-v2
```

If you need custom SCC:

```yaml
# s4-scc.yaml
apiVersion: security.openshift.io/v1
kind: SecurityContextConstraints
metadata:
  name: s4-scc
allowHostDirVolumePlugin: false
allowHostIPC: false
allowHostNetwork: false
allowHostPID: false
allowHostPorts: false
allowPrivilegeEscalation: false
allowPrivilegedContainer: false
allowedCapabilities: null
defaultAddCapabilities: null
fsGroup:
  type: MustRunAs
readOnlyRootFilesystem: false
requiredDropCapabilities:
  - ALL
runAsUser:
  type: MustRunAsRange
seLinuxContext:
  type: MustRunAs
supplementalGroups:
  type: RunAsAny
volumes:
  - configMap
  - downwardAPI
  - emptyDir
  - persistentVolumeClaim
  - projected
  - secret
```

```bash
# Apply SCC (cluster admin required)
oc apply -f s4-scc.yaml

# Grant SCC to service account
oc adm policy add-scc-to-user s4-scc -z default -n s4
```

## Storage Configuration

### OpenShift Storage Classes

Common OpenShift storage classes:

- **ODF (OpenShift Data Foundation)**: `ocs-storagecluster-ceph-rbd`, `ocs-storagecluster-cephfs`
- **AWS EBS**: `gp2-csi`, `gp3-csi`
- **Azure Disk**: `managed-premium`
- **VMware**: `thin`, `thin-csi`

```bash
# List available storage classes
oc get storageclass

# Set default storage class (if needed)
oc patch storageclass <storage-class-name> -p '{"metadata": {"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}'
```

### Update PVCs for OpenShift

```yaml
# s4-pvc-openshift.yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: s4-data
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 10Gi
  storageClassName: ocs-storagecluster-ceph-rbd # ODF storage
---
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: s4-local-storage
spec:
  accessModes:
    - ReadWriteOnce
  resources:
    requests:
      storage: 20Gi
  storageClassName: ocs-storagecluster-ceph-rbd # ODF storage
```

```bash
# Apply PVCs
oc apply -f s4-pvc-openshift.yaml

# Check PVC status
oc get pvc
```

## Configuration with OpenShift Secrets

### Create Secrets

```bash
# Create secret from literals
oc create secret generic s4-credentials \
  --from-literal=AWS_ACCESS_KEY_ID=s4admin \
  --from-literal=AWS_SECRET_ACCESS_KEY=s4secret \
  --from-literal=UI_USERNAME=admin \
  --from-literal=UI_PASSWORD=your-secure-password \
  --from-literal=JWT_SECRET=your-random-secret-key

# View secrets (values are base64 encoded)
oc get secret s4-credentials -o yaml

# Edit secret
oc edit secret s4-credentials
```

### Using OpenShift ConfigMaps

```bash
# Create ConfigMap
oc create configmap s4-config \
  --from-literal=AWS_DEFAULT_REGION=us-east-1 \
  --from-literal=PORT=5000 \
  --from-literal=MAX_FILE_SIZE_GB=20

# Edit ConfigMap
oc edit configmap s4-config
```

## Monitoring and Logging

### OpenShift Console

Access S4 resources in OpenShift console:

1. **Administrator View**

   - Workloads -> Deployments -> s4
   - Networking -> Services -> s4
   - Networking -> Routes -> s4
   - Storage -> PersistentVolumeClaims

2. **Developer View**
   - Topology -> s4 application
   - Project -> s4

### Logs

```bash
# View logs in CLI
oc logs -l app=s4 -f

# View logs in console
# Navigate to: Workloads -> Pods -> <s4-pod> -> Logs
```

### Metrics

OpenShift includes Prometheus for monitoring:

```bash
# View metrics in console
# Navigate to: Observe -> Metrics
# Query: container_memory_usage_bytes{pod=~"s4-.*"}
```

## OpenShift Templates

### Create Template

```yaml
# s4-template.yaml
apiVersion: template.openshift.io/v1
kind: Template
metadata:
  name: s4
  annotations:
    description: 'S4 - Super Simple Storage Service'
    tags: 'storage,s3,object-storage'
    iconClass: 'icon-storage'
objects:
  - apiVersion: v1
    kind: Secret
    metadata:
      name: s4-credentials
    stringData:
      AWS_ACCESS_KEY_ID: ${S3_ACCESS_KEY}
      AWS_SECRET_ACCESS_KEY: ${S3_SECRET_KEY}
      UI_USERNAME: ${UI_USERNAME}
      UI_PASSWORD: ${UI_PASSWORD}
      JWT_SECRET: ${JWT_SECRET}
  - apiVersion: v1
    kind: ConfigMap
    metadata:
      name: s4-config
    data:
      AWS_DEFAULT_REGION: ${AWS_REGION}
      PORT: '5000'
  - apiVersion: v1
    kind: PersistentVolumeClaim
    metadata:
      name: s4-data
    spec:
      accessModes:
        - ReadWriteOnce
      resources:
        requests:
          storage: ${STORAGE_SIZE}
      storageClassName: ${STORAGE_CLASS}
  - apiVersion: apps/v1
    kind: Deployment
    metadata:
      name: s4
    spec:
      replicas: 1
      selector:
        matchLabels:
          app: s4
      template:
        metadata:
          labels:
            app: s4
        spec:
          containers:
            - name: s4
              image: quay.io/rh-aiservices-bu/s4:${IMAGE_TAG}
              ports:
                - containerPort: 5000
                - containerPort: 7480
              envFrom:
                - configMapRef:
                    name: s4-config
                - secretRef:
                    name: s4-credentials
              volumeMounts:
                - name: s4-data
                  mountPath: /var/lib/ceph/radosgw
          volumes:
            - name: s4-data
              persistentVolumeClaim:
                claimName: s4-data
  - apiVersion: v1
    kind: Service
    metadata:
      name: s4
    spec:
      ports:
        - name: web-ui
          port: 5000
        - name: s3-api
          port: 7480
      selector:
        app: s4
  - apiVersion: route.openshift.io/v1
    kind: Route
    metadata:
      name: s4
    spec:
      port:
        targetPort: web-ui
      tls:
        termination: edge
      to:
        kind: Service
        name: s4
parameters:
  - name: S3_ACCESS_KEY
    description: 'S3 Access Key'
    value: 's4admin'
    required: true
  - name: S3_SECRET_KEY
    description: 'S3 Secret Key'
    value: 's4secret'
    required: true
  - name: UI_USERNAME
    description: 'Web UI Username'
    value: 'admin'
  - name: UI_PASSWORD
    description: 'Web UI Password'
    generate: expression
    from: '[a-zA-Z0-9]{16}'
  - name: JWT_SECRET
    description: 'JWT Secret Key'
    generate: expression
    from: '[a-zA-Z0-9]{32}'
  - name: AWS_REGION
    description: 'AWS Region'
    value: 'us-east-1'
  - name: STORAGE_SIZE
    description: 'Storage Size'
    value: '10Gi'
  - name: STORAGE_CLASS
    description: 'Storage Class'
    value: 'ocs-storagecluster-ceph-rbd'
  - name: IMAGE_TAG
    description: 'S4 Image Tag'
    value: 'latest'
```

### Deploy from Template

```bash
# Upload template
oc create -f s4-template.yaml -n openshift

# Deploy from template
oc process s4 \
  -p S3_ACCESS_KEY=myadmin \
  -p S3_SECRET_KEY=mysecret \
  -p UI_USERNAME=admin \
  -p UI_PASSWORD=pass \
  -p STORAGE_CLASS=ocs-storagecluster-ceph-rbd | oc apply -f -

# Or use console
# Navigate to: Developer -> +Add -> From Catalog -> S4
```

## Integration with OpenShift AI / RHOAI

S4 can be integrated with OpenShift AI (formerly RHOAI) for model storage:

### Data Connection

Create a Data Connection in OpenShift AI:

1. Navigate to OpenShift AI dashboard
2. Data Science Projects -> Your Project -> Data Connections
3. Add Data Connection:
   - Name: `s4-storage`
   - Access key: `s4admin`
   - Secret key: `s4secret`
   - Endpoint: `http://s4.s4.svc.cluster.local:7480`
   - Region: `us-east-1`

### Workbench Configuration

Mount S4 storage in workbench:

```yaml
env:
  - name: AWS_ACCESS_KEY_ID
    valueFrom:
      secretKeyRef:
        name: s4-credentials
        key: AWS_ACCESS_KEY_ID
  - name: AWS_SECRET_ACCESS_KEY
    valueFrom:
      secretKeyRef:
        name: s4-credentials
        key: AWS_SECRET_ACCESS_KEY
  - name: AWS_S3_ENDPOINT
    value: 'http://s4.s4.svc.cluster.local:7480'
  - name: AWS_DEFAULT_REGION
    value: 'us-east-1'
```

## Troubleshooting

### Route Not Accessible

```bash
# Check Route
oc get route s4

# Check if service has endpoints
oc get endpoints s4

# Test from another pod
oc run -it --rm debug --image=registry.access.redhat.com/ubi8/ubi -- curl http://s4:5000
```

### SCC Issues

```bash
# Check pod SCC
oc describe pod -l app=s4 | grep scc

# Check pod security context
oc get pod -l app=s4 -o yaml | grep -A 10 securityContext

# View SCC details
oc describe scc restricted
```

### Storage Issues

```bash
# Check PVC status
oc get pvc

# Describe PVC for events
oc describe pvc s4-data

# Check storage class
oc get storageclass
```

## Best Practices

### Production Deployment

- ✅ Use Routes with TLS edge termination
- ✅ Configure resource limits and requests
- ✅ Use ODF/OCS storage for production
- ✅ Enable monitoring and alerts
- ✅ Set up backup strategy (Velero, OADP)
- ✅ Use separate projects for dev/staging/prod
- ✅ Configure network policies
- ✅ Regular security scans

### High Availability Considerations

S4 is designed for **single-replica deployment** due to its SQLite backend and in-memory state (see [Kubernetes Deployment Architecture](./kubernetes.md#deployment-architecture)). Multi-replica scaling is not supported.

To maximize uptime within this constraint:

- **PodDisruptionBudget**: Prevent voluntary evictions during maintenance
- **Liveness/Readiness probes**: Enable automatic restart on failure
- **Reliable storage**: Use a production-grade StorageClass (ODF, EBS, etc.)
- **Resource requests/limits**: Prevent OOM kills and ensure scheduling

```yaml
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: s4
spec:
  minAvailable: 1
  selector:
    matchLabels:
      app: s4
```

## Related Documentation

- [Kubernetes Deployment](./kubernetes.md) - Base Kubernetes deployment
- [Configuration Guide](./configuration.md) - Environment variables
- [Production Readiness](./production-readiness.md) - Production checklist
- [OpenShift Documentation](https://docs.openshift.com)
