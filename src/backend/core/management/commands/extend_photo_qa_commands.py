"""Apply an explicit, additive update to the administrator-managed photo rules."""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import AIPrompt

EXTENSIONS = {
    "call.tool.photo": (
        "再次拍图请求：用户本轮说“再看看”“再看一下”及其自然派生短语，"
        "例如“你再看看”“再看一下嘛”“帮我再看看”“再帮我看一下”“你再看看这个”，"
        "表达让你重新查看眼前画面的意图时，也调用take_photo，获取一张新照片；"
        "不得只复述上次答案或复用旧照片。用户提出新问题时使用新问题；"
        "没有新问题但有上一轮拍图问题时，question沿用上一轮问题；"
        "没有可沿用的问题时，question为“请描述并解释眼前的主要物体”。"
        "这些请求不切换语音/视频模式；“打开摄像头”“关闭摄像头”仍使用set_camera_enabled。"
        "仅凭“再”或“看”字不能触发拍照：“不要再看了”“别再看一下”“再看看怎么打开摄像头”、"
        "讨论用法、假设或引用短语不属于重新拍图授权；意图不明确先澄清。"
    ),
    "call.tool.description.take_photo": (
        "也支持“再看看”“再看一下”及“你再看看”“再看一下嘛”等重新看图请求，"
        "每次获取新照片；未提出新问题时沿用上一轮拍图问题，无上下文时描述眼前主要物体。"
        "否定、引用、假设、用法询问不触发拍图；打开/关闭摄像头仍使用set_camera_enabled。"
    ),
}


class Command(BaseCommand):
    help = "Add repeat-look voice requests to existing photo QA prompts without replacing admin edits."

    @transaction.atomic
    def handle(self, *args, **options):
        prompts = {
            prompt.code: prompt
            for prompt in AIPrompt.objects.select_for_update().filter(
                code__in=EXTENSIONS
            )
        }
        if set(prompts) != set(EXTENSIONS):
            raise CommandError(
                "Photo QA prompts are missing; apply migration 0200 first."
            )
        if any(
            prompt.scope != "system" or not prompt.content.strip()
            for prompt in prompts.values()
        ):
            raise CommandError("Photo QA prompts must be nonempty system instructions.")
        updated = 0
        for code, extension in EXTENSIONS.items():
            prompt = prompts[code]
            if extension not in prompt.content:
                prompt.content += "\n" + extension
                prompt.save(update_fields=["content"])
                updated += 1
        self.stdout.write(f"updated={updated}")
