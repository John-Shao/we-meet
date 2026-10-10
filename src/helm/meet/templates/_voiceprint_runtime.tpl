{{- define "meet.voiceprint.backendImage" -}}
{{- include "meet.image.reference" (dict "image" .Values.backend.image "fallback" .Values.image) -}}
{{- end -}}

{{- define "meet.voiceprint.validateRuntime" -}}
{{- if .Values.voiceprintWorkers.enabled -}}
{{- if not .Values.voiceprintRuntime.enabled -}}{{ fail "voiceprintWorkers requires voiceprintRuntime.enabled" }}{{- end -}}
{{- if not .Values.celeryBeat.enabled -}}{{ fail "voiceprintWorkers requires singleton celeryBeat" }}{{- end -}}
{{- if or (ne (toString (get .Values.backend.envVars "CELERY_ENABLED")) "true") (eq (toString (get .Values.backend.envVars "CELERY_TASK_ALWAYS_EAGER")) "true") -}}
{{- fail "voiceprintWorkers requires backend CELERY_ENABLED=true and eager execution disabled" -}}
{{- end -}}
{{- if not (regexMatch "^[1-8]$" (toString .Values.voiceprintWorkers.replicas)) -}}{{ fail "voiceprintWorkers.replicas must be an integer from 1 to 8" }}{{- end -}}
{{- if or (ne (get .Values.voiceprintWorkers.nodeSelector "kubernetes.io/os") "linux") (ne (get .Values.voiceprintWorkers.nodeSelector "kubernetes.io/arch") "amd64") -}}{{ fail "voiceprintWorkers requires Linux amd64 node selectors" }}{{- end -}}
{{- range $key, $value := .Values.celeryBeat.envVars -}}
{{- if or (hasPrefix "MEETING_VOICEPRINT_" $key) (hasPrefix "CELERY_" $key) (hasPrefix "DB_" $key) (eq $key "DATABASE_URL") -}}
{{- if ne (toJson $value) (toJson (get $.Values.backend.envVars $key)) -}}{{ fail "voiceprint Beat must share backend database, broker and feature settings" }}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}
{{- if .Values.voiceprintRuntime.enabled -}}
{{- $_ := required "voiceprintRuntime.configurationSecret is required" .Values.voiceprintRuntime.configurationSecret -}}
{{- if not (regexMatch "^[^[:space:]@]+@sha256:[a-f0-9]{64}$" (include "meet.voiceprint.backendImage" .)) -}}{{ fail "voiceprintRuntime requires an immutable backend image.reference digest" }}{{- end -}}
{{- $uid := toString .Values.voiceprintRuntime.userId -}}
{{- if or (not (regexMatch "^[0-9]{4,5}$" $uid)) (lt (int $uid) 1000) (gt (int $uid) 65535) -}}{{ fail "voiceprintRuntime.userId must be an integer from 1000 to 65535" }}{{- end -}}
{{- $_ := required "voiceprintRuntime.tmpSizeLimit is required" .Values.voiceprintRuntime.tmpSizeLimit -}}
{{- end -}}
{{- end -}}

{{- define "meet.voiceprint.backendEnv" -}}
{{- $root := .root -}}
{{- $env := deepCopy (.env | default dict) -}}
{{- if $root.Values.voiceprintRuntime.enabled -}}
{{- range $key, $value := $env -}}
{{- if or (hasPrefix "MEETING_VOICEPRINT_" $key) (hasPrefix "CELERY_" $key) (hasPrefix "DB_" $key) (eq $key "DATABASE_URL") -}}
{{- if ne (toJson $value) (toJson (get $root.Values.backend.envVars $key)) -}}{{ fail "voiceprint API pools must share backend feature and private configuration settings" }}{{- end -}}
{{- end -}}
{{- if and (hasSuffix "_FILE" $key) (not (hasPrefix "MEETING_VOICEPRINT_" $key)) -}}
{{- if or (not (kindIs "string" $value)) (not (hasPrefix "/run/voiceprint-backend/" $value)) (ne (clean $value) $value) -}}{{ fail "voiceprintRuntime shared credential files must be mounted under /run/voiceprint-backend or use Secret environment references" }}{{- end -}}
{{- end -}}
{{- end -}}
{{- range $key, $filename := dict "MEETING_VOICEPRINT_KEYRING_FILE" "keyring.json" "MEETING_VOICEPRINT_ENCODER_CONFIG_FILE" "encoder.json" "MEETING_VOICEPRINT_QUALITY_CONFIG_FILE" "quality.json" "MEETING_VOICEPRINT_MEDIA_CONFIG_FILE" "media.json" "MEETING_VOICEPRINT_THRESHOLD_CONFIG_FILE" "threshold.json" -}}
{{- $path := printf "/run/voiceprint-backend/%s" $filename -}}
{{- if and (hasKey $env $key) (ne (toString (get $env $key)) $path) -}}{{ fail "voiceprintRuntime private file paths must use /run/voiceprint-backend" }}{{- end -}}
{{- $_ := set $env $key $path -}}
{{- end -}}
{{- $_ := set $env "HOME" "/tmp" -}}
{{- if and (hasKey $env "TMPDIR") (ne (toString (get $env "TMPDIR")) "/tmp") -}}{{ fail "voiceprintRuntime TMPDIR must use the shared /tmp volume" }}{{- end -}}
{{- $_ := set $env "TMPDIR" "/tmp" -}}
{{- $_ := set $env "PYTHONDONTWRITEBYTECODE" "1" -}}
{{- end -}}
{{- if $root.Values.voiceprintSampler.enabled -}}
{{- $nameKey := "MEETING_VOICEPRINT_SAMPLING_AGENT_NAME" -}}
{{- $tokenKey := "MEETING_VOICEPRINT_SAMPLING_AGENT_TOKEN" -}}
{{- $name := $root.Values.voiceprintSampler.agentName -}}
{{- $token := dict "secretKeyRef" (dict "name" $root.Values.voiceprintSampler.credentialsSecret "key" "sampling-token") -}}
{{- range $source := list $env $root.Values.backend.envVars $root.Values.celeryBeat.envVars -}}
{{- if hasKey $source (printf "%s_FILE" $tokenKey) -}}{{ fail "voiceprintSampler backend token must use the shared sampling-token Secret reference" }}{{- end -}}
{{- if and (hasKey $source $nameKey) (ne (toJson (get $source $nameKey)) (toJson $name)) -}}{{ fail "voiceprintSampler agent name must match backend and Beat" }}{{- end -}}
{{- if and (hasKey $source $tokenKey) (ne (toJson (get $source $tokenKey)) (toJson $token)) -}}{{ fail "voiceprintSampler token must use the shared sampling-token Secret reference" }}{{- end -}}
{{- end -}}
{{- $_ := set $env $nameKey $name -}}
{{- $_ := set $env $tokenKey $token -}}
{{- end -}}
{{- include "meet.env.transformDict" $env -}}
{{- end -}}

{{- define "meet.voiceprint.validateMounts" -}}
{{- if .root.Values.voiceprintRuntime.enabled -}}
{{- if hasKey (.config.podAnnotations | default dict) "meet.voiceprint/configuration-revision" -}}{{ fail "voiceprintRuntime configuration revision annotation is reserved" }}{{- end -}}
{{- $mounts := concat (.root.Values.mountFiles | default list) (.config.extraVolumeMounts | default list) -}}
{{- range $name, $volume := .config.persistence -}}
{{- if has $name (list "voiceprint-private" "voiceprint-tmp") -}}{{ fail "voiceprintRuntime volume names are reserved" }}{{- end -}}
{{- $mounts = append $mounts (dict "mountPath" $volume.mountPath) -}}
{{- end -}}
{{- range .config.extraVolumes -}}
{{- if has .name (list "voiceprint-private" "voiceprint-tmp") -}}{{ fail "voiceprintRuntime volume names are reserved" }}{{- end -}}
{{- end -}}
{{- range $mounts -}}
{{- if has (.name | default "") (list "voiceprint-private" "voiceprint-tmp") -}}{{ fail "voiceprintRuntime volume names are reserved" }}{{- end -}}
{{- $path := clean (toString (.mountPath | default .path)) -}}
{{- range $base := list "/tmp" "/run/voiceprint-backend" -}}
{{- if or (eq $path "/") (eq $path $base) (hasPrefix (printf "%s/" $base) $path) (hasPrefix (printf "%s/" $path) $base) -}}{{ fail "voiceprintRuntime private and temporary mount paths are reserved" }}{{- end -}}
{{- end -}}
{{- end -}}
{{- range .config.sidecars -}}
{{- if eq .name "voiceprint-query-janitor" -}}{{ fail "voiceprintRuntime janitor container name is reserved" }}{{- end -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "meet.voiceprint.nodeSelector" -}}
{{- $selector := deepCopy (.config.nodeSelector | default dict) -}}
{{- if .root.Values.voiceprintRuntime.enabled -}}
{{- range $key, $value := dict "kubernetes.io/os" "linux" "kubernetes.io/arch" "amd64" -}}
{{- if and (hasKey $selector $key) (ne (get $selector $key) $value) -}}{{ fail "voiceprintRuntime API pools require Linux amd64 node selectors" }}{{- end -}}
{{- $_ := set $selector $key $value -}}
{{- end -}}
{{- end -}}
{{- if $selector }}{{ toYaml $selector }}{{ end -}}
{{- end -}}

{{- define "meet.voiceprint.podSecurity" -}}
{{- $context := deepCopy (.context | default dict) -}}
{{- if .root.Values.voiceprintRuntime.enabled -}}
{{- $uid := int .root.Values.voiceprintRuntime.userId -}}
{{- range $key := list "runAsUser" "runAsGroup" "fsGroup" -}}
{{- if and (hasKey $context $key) (ne (toString (get $context $key)) (toString $uid)) -}}{{ fail "voiceprintRuntime requires matching API, worker and janitor UID/GID" }}{{- end -}}
{{- $_ := set $context $key $uid -}}
{{- end -}}
{{- $_ := set $context "runAsNonRoot" true -}}
{{- end -}}
{{- if $context }}{{ toYaml $context }}{{ end -}}
{{- end -}}

{{- define "meet.voiceprint.containerSecurity" -}}
{{- $context := deepCopy (.context | default dict) -}}
{{- if .root.Values.voiceprintRuntime.enabled -}}
{{- $uid := int .root.Values.voiceprintRuntime.userId -}}
{{- range $key := list "runAsUser" "runAsGroup" -}}
{{- if and (hasKey $context $key) (ne (toString (get $context $key)) (toString $uid)) -}}{{ fail "voiceprintRuntime requires matching API, worker and janitor UID/GID" }}{{- end -}}
{{- $_ := set $context $key $uid -}}
{{- end -}}
{{- $_ := set $context "runAsNonRoot" true -}}
{{- $_ := set $context "allowPrivilegeEscalation" false -}}
{{- $_ := set $context "capabilities" (dict "drop" (list "ALL")) -}}
{{- end -}}
{{- if $context }}{{ toYaml $context }}{{ end -}}
{{- end -}}

{{- define "meet.voiceprint.volumeMounts" -}}
- {name: voiceprint-private, mountPath: /run/voiceprint-backend, readOnly: true}
- {name: voiceprint-tmp, mountPath: /tmp}
{{- end -}}

{{- define "meet.voiceprint.volumes" -}}
- name: voiceprint-private
  secret:
    secretName: {{ .Values.voiceprintRuntime.configurationSecret | quote }}
    defaultMode: 0440
- name: voiceprint-tmp
  emptyDir:
    sizeLimit: {{ .Values.voiceprintRuntime.tmpSizeLimit }}
{{- end -}}

{{- define "meet.voiceprint.janitor" -}}
- name: voiceprint-query-janitor
  image: {{ include "meet.voiceprint.backendImage" . | quote }}
  imagePullPolicy: {{ (.Values.backend.image | default dict).pullPolicy | default .Values.image.pullPolicy }}
  command: [python, -m, core.services.voiceprint_query_janitor]
  env:
    - {name: HOME, value: /tmp}
    - {name: TMPDIR, value: /tmp}
    - {name: PYTHONDONTWRITEBYTECODE, value: "1"}
  securityContext:
    runAsNonRoot: true
    runAsUser: {{ .Values.voiceprintRuntime.userId }}
    runAsGroup: {{ .Values.voiceprintRuntime.userId }}
    allowPrivilegeEscalation: false
    readOnlyRootFilesystem: true
    capabilities: {drop: [ALL]}
  resources:
    {{- toYaml .Values.voiceprintRuntime.janitorResources | nindent 4 }}
  volumeMounts:
    - {name: voiceprint-tmp, mountPath: /tmp}
{{- end -}}
