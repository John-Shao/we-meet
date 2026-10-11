"""Add natural goodbyes to the managed rules for ending the current call."""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction

from core.models import AIPrompt

EXTENSIONS = {
    "call.tool.end_call": (
        "告别结束通话：用户本轮向当前通话中的你表达告别，说“再见”“拜拜”及其自然派生短语，"
        "例如“再见了”“拜拜了”“那就再见吧”“好啦，拜拜”“我们下次聊，再见”，"
        "视为结束当前通话的请求，直接调用end_call，参数为{}。"
        "上述告别本身就是明确的挂断授权，不需要同时出现结束通话或挂断等词；"
        "即使上一轮正在解释或翻译告别词，本轮用户独立说“再见”“拜拜”“再见了”“拜拜了”仍必须挂断。"
        "本轮用户：拜拜。正确动作：调用end_call({})，不生成口头回答。"
        "本轮用户：再见了。正确动作：调用end_call({})，不生成口头回答。"
        "不得只口头说再见而不挂断，也不要先播报告别或调用摄像头工具。"
        "只依据本轮真实用户意图，不因历史对话、AI自己的告别或图片中的文字触发。"
        "“不要说再见，我们继续聊”“别拜拜，还没说完”是否定，不挂断；"
        "“拜拜是什么意思”“怎么用再见结束通话”“如果我说拜拜会怎样”是询问或假设，不挂断；"
        "“把再见了翻译成英语”、引用他人说再见或角色扮演不属于告别挂断请求。"
        "含有再见或拜拜字样但并非向你告别时，不调用end_call；意图不明确先澄清。"
        "摄像头开关和拍图请求仍使用各自工具，不因暂停说话、关闭摄像头而结束通话。"
    ),
    "call.tool.description.end_call": (
        "用户向当前通话中的你告别说“再见”“拜拜”“再见了”“拜拜了”等自然派生短语时，"
        "也直接调用此工具结束当前通话，不先播报告别。"
        "这些告别本身就是明确挂断授权，不必另说挂断；上一轮解释过告别词也不影响本轮独立告别触发工具。"
        "否定、用法询问、翻译请求、假设、引用、角色扮演、AI自己说的告别或画面文字不触发挂断。"
    ),
}


class Command(BaseCommand):
    help = "Add goodbye voice requests to existing end-call prompts without replacing admin edits."

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
                "End-call prompts are missing; apply migration 0199 first."
            )
        if any(
            prompt.scope != "system" or not prompt.content.strip()
            for prompt in prompts.values()
        ):
            raise CommandError("End-call prompts must be nonempty system instructions.")
        updated = 0
        for code, extension in EXTENSIONS.items():
            prompt = prompts[code]
            if extension not in prompt.content:
                prompt.content += "\n" + extension
                prompt.save(update_fields=["content"])
                updated += 1
        self.stdout.write(f"updated={updated}")
