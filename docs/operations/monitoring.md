# Monitoring and Observability

Guide for monitoring S4 in production.

## Overview

S4 provides logging, metrics, and health checks for monitoring and observability. This guide covers:

- Log aggregation
- Metrics and monitoring
- Health checks
- Alerting strategies

## Logging

### Log Outputs

S4 produces logs via:

1. **Application Logs** (stdout/stderr)

   - Backend API logs (Fastify)
   - Frontend build logs (Webpack)
   - Authentication events
   - S3 operations

2. **Process Logs** (container stdout/stderr)
   - RGW daemon output (`/usr/bin/rgw-standalone`)
   - Node.js backend output
   - Entrypoint supervision messages (`[entrypoint] started …`)

### Log Levels

- **INFO**: Normal operations, requests
- **WARN**: Potential issues, deprecated features
- **ERROR**: Errors, exceptions, failed operations

### Viewing Logs

**Container (Docker/Podman)**:

```bash
# All logs
podman logs s4

# Follow logs
podman logs -f s4

# Last 100 lines
podman logs --tail 100 s4

# Only RGW output
podman logs s4 | grep -i rgw
```

**Kubernetes**:

```bash
# Pod logs
kubectl logs -l app=s4 -f

# Previous container (if restarted)
kubectl logs <pod-name> --previous

# Specific container
kubectl logs <pod-name> -c s4

# Multiple pods
kubectl logs -l app=s4 --all-containers=true -f
```

**OpenShift**:

```bash
# View in CLI
oc logs -l app=s4 -f

# View in console
# Navigate to: Workloads -> Pods -> <s4-pod> -> Logs
```

### Log Aggregation

#### Elasticsearch, Logstash, Kibana (ELK)

**Filebeat Configuration**:

```yaml
# filebeat.yml
filebeat.inputs:
  - type: container
    paths:
      - '/var/lib/docker/containers/*/*.log'
    processors:
      - add_kubernetes_metadata:
          in_cluster: true
          default_indexers.enabled: false
          default_matchers.enabled: false
          indexers:
            - container:
          matchers:
            - fields:
                lookup_fields: ['container.id']

output.elasticsearch:
  hosts: ['elasticsearch:9200']
  index: 's4-logs-%{+yyyy.MM.dd}'
```

**Query in Kibana**:

```
kubernetes.labels.app: "s4" AND message: "error"
```

#### Fluentd

```yaml
# fluentd-configmap.yaml
<source>
@type tail
path /var/log/containers/*s4*.log
pos_file /var/log/s4-containers.log.pos
tag kubernetes.*
format json
</source>

<match kubernetes.var.log.containers.**s4**.log>
@type elasticsearch
host elasticsearch
port 9200
logstash_format true
logstash_prefix s4
</match>
```

#### Splunk

```bash
# Forward logs to Splunk
kubectl logs -l app=s4 -f | splunk add oneshot -
```

### Structured Logging

S4 uses structured logging with context:

```json
{
  "level": "info",
  "time": "2026-01-30T10:00:00.000Z",
  "pid": 1,
  "hostname": "s4-pod-123",
  "reqId": "req-xyz",
  "msg": "GET /api/buckets",
  "req": {
    "method": "GET",
    "url": "/api/buckets",
    "headers": {...}
  },
  "responseTime": 45
}
```

## Metrics

### Application Metrics

S4 can export metrics for monitoring dashboards.

#### Prometheus Integration (Future Enhancement)

```javascript
// Example metrics to implement
const httpRequestDuration = new Histogram({
  name: 's4_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
});

const s3OperationCounter = new Counter({
  name: 's4_s3_operations_total',
  help: 'Total number of S3 operations',
  labelNames: ['operation', 'bucket', 'status'],
});

const activeTransfers = new Gauge({
  name: 's4_active_transfers',
  help: 'Number of active file transfers',
});
```

#### Metrics Endpoint

Future `/metrics` endpoint would expose:

- HTTP request rates and latencies
- S3 operation counts (GET, PUT, DELETE)
- Active file transfers
- Upload/download throughput
- Error rates
- Authentication attempts

### Resource Metrics

**Container**:

```bash
# CPU and memory usage
podman stats s4

# Continuous monitoring
watch -n 2 podman stats s4
```

**Kubernetes**:

```bash
# Pod metrics
kubectl top pod -l app=s4

# Node metrics
kubectl top nodes

# Detailed metrics
kubectl describe pod <s4-pod> | grep -A 5 "Resources"
```

**OpenShift**:

```bash
# CLI metrics
oc adm top pod -l app=s4

# Console metrics
# Navigate to: Observe -> Metrics -> Custom Query
# Query: container_memory_usage_bytes{pod=~"s4-.*"}
```

### Kubernetes Metrics Server

Ensure metrics-server is installed:

```bash
# Check metrics-server
kubectl get deployment metrics-server -n kube-system

# If not installed, install it
kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml
```

## Health Checks

### Readiness Probe

**Endpoint**: `GET /api/disclaimer`
**Purpose**: Determines if pod is ready to receive traffic
**Initial Delay**: 15 seconds
**Period**: 10 seconds
**Timeout**: 5 seconds

**Kubernetes Configuration**:

```yaml
readinessProbe:
  httpGet:
    path: /api/disclaimer
    port: 5000
  initialDelaySeconds: 15
  periodSeconds: 10
  timeoutSeconds: 5
  successThreshold: 1
  failureThreshold: 3
```

### Liveness Probe

**Endpoint**: `GET /api/disclaimer`
**Purpose**: Restarts pod if unresponsive
**Initial Delay**: 60 seconds
**Period**: 30 seconds
**Timeout**: 10 seconds

**Kubernetes Configuration**:

```yaml
livenessProbe:
  httpGet:
    path: /api/disclaimer
    port: 5000
  initialDelaySeconds: 60
  periodSeconds: 30
  timeoutSeconds: 10
  successThreshold: 1
  failureThreshold: 3
```

### Manual Health Checks

```bash
# Check web UI health
curl -f http://localhost:5000/api/disclaimer

# Check S3 API health
curl -f http://localhost:7480/

# Check with authentication
curl -H "Authorization: Bearer $TOKEN" http://localhost:5000/api/auth/me
```

## Alerting

### Prometheus Alerts (Future Enhancement)

```yaml
# s4-alerts.yaml
groups:
  - name: s4
    interval: 30s
    rules:
      # High error rate
      - alert: S4HighErrorRate
        expr: rate(s4_http_requests_total{status_code=~"5.."}[5m]) > 0.05
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'S4 high error rate'
          description: 'Error rate is {{ $value }} errors/sec'

      # High response time
      - alert: S4HighLatency
        expr: histogram_quantile(0.95, rate(s4_http_request_duration_seconds_bucket[5m])) > 2
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'S4 high latency'
          description: '95th percentile latency is {{ $value }}s'

      # Pod restarts
      - alert: S4PodRestarting
        expr: rate(kube_pod_container_status_restarts_total{pod=~"s4-.*"}[15m]) > 0
        for: 5m
        labels:
          severity: critical
        annotations:
          summary: 'S4 pod restarting'
          description: 'Pod {{ $labels.pod }} is restarting'

      # Pod not ready
      - alert: S4PodNotReady
        expr: kube_pod_status_ready{pod=~"s4-.*",condition="true"} == 0
        for: 10m
        labels:
          severity: critical
        annotations:
          summary: 'S4 pod not ready'
          description: 'Pod {{ $labels.pod }} is not ready'

      # High memory usage
      - alert: S4HighMemoryUsage
        expr: container_memory_usage_bytes{pod=~"s4-.*"} / container_spec_memory_limit_bytes{pod=~"s4-.*"} > 0.9
        for: 5m
        labels:
          severity: warning
        annotations:
          summary: 'S4 high memory usage'
          description: 'Memory usage is {{ $value | humanizePercentage }}'
```

### Kubernetes Events

```bash
# Watch for events
kubectl get events --watch --field-selector involvedObject.name=s4

# Recent events
kubectl get events --field-selector involvedObject.name=s4 --sort-by='.lastTimestamp'

# Event types to monitor
# - Warning: Failed to pull image
# - Warning: Back-off restarting failed container
# - Warning: FailedScheduling
# - Normal: Pulled (image pull successful)
# - Normal: Started (container started)
```

## Dashboards

### Grafana Dashboard (Example)

```json
{
  "dashboard": {
    "title": "S4 Overview",
    "panels": [
      {
        "title": "HTTP Request Rate",
        "targets": [
          {
            "expr": "rate(s4_http_requests_total[5m])"
          }
        ]
      },
      {
        "title": "Response Time (p95)",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(s4_http_request_duration_seconds_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Active Transfers",
        "targets": [
          {
            "expr": "s4_active_transfers"
          }
        ]
      },
      {
        "title": "Pod Memory Usage",
        "targets": [
          {
            "expr": "container_memory_usage_bytes{pod=~\"s4-.*\"}"
          }
        ]
      }
    ]
  }
}
```

### Kubernetes Dashboard

Built-in Kubernetes dashboard shows:

- Pod status and restarts
- CPU and memory usage
- Network I/O
- Storage usage

```bash
# Deploy Kubernetes Dashboard
kubectl apply -f https://raw.githubusercontent.com/kubernetes/dashboard/v2.7.0/aio/deploy/recommended.yaml

# Access dashboard
kubectl proxy
# Open: http://localhost:8001/api/v1/namespaces/kubernetes-dashboard/services/https:kubernetes-dashboard:/proxy/
```

## Tracing (Future Enhancement)

### OpenTelemetry Integration

```javascript
// Example OpenTelemetry setup
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');

const provider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: 's4-backend',
  }),
});

// Export to Jaeger/Zipkin
const { JaegerExporter } = require('@opentelemetry/exporter-jaeger');
const exporter = new JaegerExporter({
  endpoint: 'http://jaeger:14268/api/traces',
});

provider.addSpanProcessor(new BatchSpanProcessor(exporter));
provider.register();
```

## Best Practices

### 1. Log Retention

- **Development**: 7 days
- **Production**: 90 days minimum
- **Audit Logs**: 1 year (regulatory compliance)

### 2. Monitoring Coverage

Monitor:

- ✅ Application health (readiness/liveness)
- ✅ Resource usage (CPU, memory, disk)
- ✅ HTTP request rates and latencies
- ✅ Error rates and types
- ✅ Authentication failures
- ✅ S3 operation success/failure
- ✅ Active transfers and queue depth

### 3. Alerting Strategy

- **Critical**: Immediate notification (PagerDuty, Slack)
- **Warning**: Aggregated daily summary
- **Info**: Dashboard only

### 4. Dashboard Organization

- **Overview**: Key metrics at a glance
- **Performance**: Response times, throughput
- **Errors**: Error rates, types, traces
- **Resources**: CPU, memory, disk, network

## Related Documentation

- [Troubleshooting](./troubleshooting.md) - Common issues and solutions
- [Production Readiness](../deployment/production-readiness.md) - Production checklist
- [Configuration](../deployment/configuration.md) - Environment variables
