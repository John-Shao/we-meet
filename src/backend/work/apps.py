"""Work R0a app: schema, functions and domain commands live in sql/r0a_schema.sql."""

from django.apps import AppConfig


class WorkConfig(AppConfig):
    default_auto_field = "django.db.models.BigAutoField"
    name = "work"
