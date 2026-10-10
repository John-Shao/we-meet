{{- define "meet.voiceprint.encoderName" -}}
{{- printf "%s-voiceprint-encoder" (include "meet.fullname" . | trunc 44 | trimSuffix "-") -}}
{{- end -}}
