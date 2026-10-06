/**
 * Standalone welcome-demo controller.
 *
 * Side-effect-free by construction: every action is simulated in this page.
 * No settings are read or written, no network requests are made, and nothing
 * is persisted (the URL hash only carries deep-link state for screenshots).
 * Deep links: #step=1..7&stop=0..4&run=1
 */
;(() => {
  'use strict'

  const $ = (sel) => document.querySelector(sel)
  const $$ = (sel) => Array.from(document.querySelectorAll(sel))

  const STEP_META = {
    1: { label: 'Welcome' },
    2: { label: 'Security & access' },
    3: { label: 'First provider' },
    4: { label: 'Intelligence' },
    5: { label: 'The tour' },
    6: { label: 'Agents' },
    7: { label: 'Done' },
  }

  const STEPS = [1, 2, 3, 4, 5, 6, 7]

  // Tour stops over the placeholder chrome. `place` is where the tip sits
  // relative to the spotlighted region.
  const TOUR = [
    {
      target: '.app-rpanel',
      place: 'left',
      pad: 8,
      title: 'The sidebar',
      body: 'Files, Git, Watchtower, Context, Agent Models, Capabilities: the right-hand tabs. Files browses the workspace, Git tracks changes, Watchtower follows background jobs, Context shows how much of the model\'s window is in use, Agent Models assigns the model seats, Capabilities lists what agents can do. Unused tabs can be hidden.',
    },
    {
      target: '[data-spot="settings"]',
      place: 'right',
      pad: 8,
      title: 'Settings',
      body: 'Models, Orchestration, Permissions, Dynamic: the switches all live behind this row.',
    },
    {
      target: '[data-spot="plugins"]',
      place: 'right',
      pad: 8,
      title: 'Plugins, skills & MCP',
      body: 'Skills and MCP servers are added here and under Settings → Dynamic.',
    },
    {
      target: '[data-spot="composer"]',
      place: 'top',
      pad: 8,
      title: 'The composer switches',
      body: 'Agent preset, access mode, model picker and plan: the four composer controls.',
    },
    {
      target: '[data-spot="context"]',
      place: 'right',
      pad: 8,
      title: 'Context Dashboard',
      body: "How much of the model's window your sessions are using. Open it any time from here.",
    },
  ]

  // Step 3 catalogue: the full mainstream preset snapshot from the shipped
  // provider-presets.ts (212 presets generated from the models.dev mirror, in
  // its name order) — the same list AddProviderModal renders. Regenerate this
  // block when that file changes; nothing here is written anywhere.
  const CATALOGUE = [
    {"id":"302ai","name":"302.AI","env":["302AI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.302.ai/v1","doc":"https://doc.302.ai"},
    {"id":"abacus","name":"Abacus","env":["ABACUS_API_KEY"],"protocol":"openai-completions","baseURL":"https://routellm.abacus.ai/v1","doc":"https://abacus.ai/help/api"},
    {"id":"abliteration-ai","name":"abliteration.ai","env":["ABLIT_KEY"],"protocol":"openai-completions","baseURL":"https://api.abliteration.ai/v1","doc":"https://docs.abliteration.ai/models"},
    {"id":"above","name":"above.dev","env":["ABOVE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.above.dev/v1","doc":"https://above.dev/docs"},
    {"id":"agentrouter","name":"AgentRouter","env":["AGENTROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://agentrouter.org/v1","doc":"https://agentrouter.org/docs/opencode.html"},
    {"id":"agnes","name":"Agnes AI","env":["AGNES_API_KEY"],"protocol":"openai-completions","baseURL":"https://apihub.agnes-ai.com/v1","doc":"https://agnes-ai.com/doc"},
    {"id":"ai-router","name":"AI-ROUTER","env":["AI_ROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.ai-router.dev/v1","doc":"https://ai-router.dev/openai-compatible-api-gateway/"},
    {"id":"aiand","name":"ai&","env":["AIAND_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.aiand.com/v1","doc":"https://docs.aiand.com/"},
    {"id":"aihubmix","name":"AIHubMix","env":["AIHUBMIX_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.aihubmix.com"},
    {"id":"aixy","name":"Aixy","env":["AIXY_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.aixy-gateway.com/v1","doc":"https://docs.aixy-gateway.com/integrations/overview"},
    {"id":"aki-io","name":"AKI.IO","env":["AKI_IO_API_KEY"],"protocol":"openai-completions","baseURL":"https://aki.io/v1","doc":"https://aki.io/docs/"},
    {"id":"alibaba","name":"Alibaba","env":["DASHSCOPE_API_KEY"],"protocol":"openai-completions","baseURL":"https://dashscope-intl.aliyuncs.com/compatible-mode/v1","doc":"https://www.alibabacloud.com/help/en/model-studio/models"},
    {"id":"alibaba-cn","name":"Alibaba (China)","env":["DASHSCOPE_API_KEY"],"protocol":"openai-completions","baseURL":"https://dashscope.aliyuncs.com/compatible-mode/v1","doc":"https://www.alibabacloud.com/help/en/model-studio/models"},
    {"id":"alibaba-coding-plan","name":"Alibaba Coding Plan","env":["ALIBABA_CODING_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://coding-intl.dashscope.aliyuncs.com/v1","doc":"https://www.alibabacloud.com/help/en/model-studio/coding-plan"},
    {"id":"alibaba-coding-plan-cn","name":"Alibaba Coding Plan (China)","env":["ALIBABA_CODING_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://coding.dashscope.aliyuncs.com/v1","doc":"https://help.aliyun.com/zh/model-studio/coding-plan"},
    {"id":"alibaba-token-plan","name":"Alibaba Token Plan","env":["ALIBABA_TOKEN_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1","doc":"https://www.alibabacloud.com/help/en/model-studio/token-plan-overview"},
    {"id":"alibaba-token-plan-cn","name":"Alibaba Token Plan (China)","env":["ALIBABA_TOKEN_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1","doc":"https://www.alibabacloud.com/help/zh/model-studio/token-plan-overview"},
    {"id":"amazon-bedrock","name":"Amazon Bedrock","env":["AWS_ACCESS_KEY_ID","AWS_SECRET_ACCESS_KEY","AWS_REGION","AWS_BEARER_TOKEN_BEDROCK"],"protocol":"openai-completions","baseURL":"https://bedrock-runtime.us-east-1.amazonaws.com","doc":"https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html"},
    {"id":"ambient","name":"Ambient","env":["AMBIENT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.ambient.xyz/v1","doc":"https://ambient.xyz"},
    {"id":"amd","name":"AMD","env":["AMD_API_KEY"],"protocol":"openai-completions","baseURL":"https://developer.amd.com.cn/radeon/api/v1","doc":"https://developer.amd.com.cn/radeon/tokenfactory"},
    {"id":"anthropic","name":"Anthropic","env":["ANTHROPIC_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.anthropic.com","doc":"https://docs.anthropic.com/en/docs/about-claude/models"},
    {"id":"anyapi","name":"AnyAPI","env":["ANYAPI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.anyapi.ai/v1","doc":"https://docs.anyapi.ai"},
    {"id":"arcee","name":"Arcee","env":["ARCEE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.arcee.ai/api/v1","doc":"https://docs.arcee.ai"},
    {"id":"atomic-chat","name":"Atomic Chat","env":["ATOMIC_CHAT_API_KEY"],"protocol":"openai-completions","baseURL":"http://127.0.0.1:1337/v1","doc":"https://atomic.chat"},
    {"id":"auriko","name":"Auriko","env":["AURIKO_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.auriko.ai/v1","doc":"https://docs.auriko.ai"},
    {"id":"azure","name":"Azure","env":["AZURE_RESOURCE_NAME","AZURE_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models"},
    {"id":"azure-cognitive-services","name":"Azure Cognitive Services","env":["AZURE_COGNITIVE_SERVICES_RESOURCE_NAME","AZURE_COGNITIVE_SERVICES_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://learn.microsoft.com/en-us/azure/ai-services/openai/concepts/models"},
    {"id":"bailing","name":"Bailing","env":["BAILING_API_TOKEN"],"protocol":"openai-completions","baseURL":"https://api.tbox.cn/api/llm/v1/chat/completions","doc":"https://alipaytbox.yuque.com/sxs0ba/ling/intro"},
    {"id":"baseten","name":"Baseten","env":["BASETEN_API_KEY"],"protocol":"openai-completions","baseURL":"https://inference.baseten.co/v1","doc":"https://docs.baseten.co/inference/model-apis/overview"},
    {"id":"berget","name":"Berget.AI","env":["BERGET_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.berget.ai/v1","doc":"https://api.berget.ai"},
    {"id":"blueclaw","name":"Blue Claw","env":["BLUECLAW_API_KEY"],"protocol":"openai-completions","baseURL":"https://openai.blueclaw.network/v1","doc":"https://blueclaw.network"},
    {"id":"bothub","name":"Bothub","env":["BOTHUB_API_KEY"],"protocol":"openai-completions","baseURL":"https://openai.bothub.ru/v1","doc":"https://bothub.ru/models"},
    {"id":"cerebras","name":"Cerebras","env":["CEREBRAS_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.cerebras.ai/v1","doc":"https://inference-docs.cerebras.ai/models/overview"},
    {"id":"hyper","name":"Charm Hyper","env":["HYPER_API_KEY"],"protocol":"openai-completions","baseURL":"https://hyper.charm.land/v1","doc":"https://hyper.charm.land"},
    {"id":"chutes","name":"Chutes","env":["CHUTES_API_KEY"],"protocol":"openai-completions","baseURL":"https://llm.chutes.ai/v1","doc":"https://llm.chutes.ai/v1/models"},
    {"id":"clarifai","name":"Clarifai","env":["CLARIFAI_PAT"],"protocol":"openai-completions","baseURL":"https://api.clarifai.com/v2/ext/openai/v1","doc":"https://docs.clarifai.com/compute/inference/"},
    {"id":"claudinio","name":"Claudinio","env":["CLAUDINIO_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.claudin.io/v1","doc":"https://claudin.io"},
    {"id":"cline-pass","name":"ClinePass","env":["CLINE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.cline.bot/api/v1","doc":"https://docs.cline.bot/getting-started/clinepass"},
    {"id":"cloudferro-sherlock","name":"CloudFerro Sherlock","env":["CLOUDFERRO_SHERLOCK_API_KEY"],"protocol":"openai-completions","baseURL":"https://api-sherlock.cloudferro.com/openai/v1/","doc":"https://docs.sherlock.cloudferro.com/"},
    {"id":"cloudflare-ai-gateway","name":"Cloudflare AI Gateway","env":["CLOUDFLARE_API_TOKEN","CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_GATEWAY_ID"],"protocol":"openai-completions","baseURL":"https://gateway.ai.cloudflare.com/v1/{CLOUDFLARE_ACCOUNT_ID}/{CLOUDFLARE_GATEWAY_ID}/anthropic","doc":"https://developers.cloudflare.com/ai-gateway/"},
    {"id":"cloudflare-workers-ai","name":"Cloudflare Workers AI","env":["CLOUDFLARE_ACCOUNT_ID","CLOUDFLARE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.cloudflare.com/client/v4/accounts/{env:CLOUDFLARE_ACCOUNT_ID}/ai/v1","doc":"https://developers.cloudflare.com/workers-ai/models/"},
    {"id":"cohere","name":"Cohere","env":["COHERE_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.cohere.com/docs/models"},
    {"id":"coralbricks","name":"CoralBricks","env":["CORAL_API_KEY"],"protocol":"openai-completions","baseURL":"https://inference.coralbricks.ai/v1","doc":"https://www.coralbricks.ai/docs"},
    {"id":"cortecs","name":"Cortecs","env":["CORTECS_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.cortecs.ai/v1","doc":"https://api.cortecs.ai/v1/models"},
    {"id":"crof","name":"CrofAI","env":["CROF_API_KEY"],"protocol":"openai-completions","baseURL":"https://crof.ai/v1","doc":"https://crof.ai/docs"},
    {"id":"crossmodel","name":"CrossModel","env":["CROSSMODEL_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.crossmodel.ai/v1","doc":"https://www.crossmodel.ai/docs"},
    {"id":"crusoe","name":"Crusoe","env":["CRUSOE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.inference.crusoecloud.com/v1","doc":"https://docs.crusoecloud.com/managed-inference/overview"},
    {"id":"drun","name":"D.Run (China)","env":["DRUN_API_KEY"],"protocol":"openai-completions","baseURL":"https://chat.d.run/v1","doc":"https://www.d.run"},
    {"id":"daoxe","name":"DaoXE","env":["DAOXE_API_KEY"],"protocol":"openai-completions","baseURL":"https://daoxe.com/v1","doc":"https://daoxe.com/pricing"},
    {"id":"databricks","name":"Databricks","env":["DATABRICKS_HOST","DATABRICKS_TOKEN"],"protocol":"openai-completions","baseURL":"https://{env:DATABRICKS_HOST}/ai-gateway/mlflow/v1","doc":"https://docs.databricks.com/aws/en/machine-learning/foundation-models/"},
    {"id":"deepinfra","name":"Deep Infra","env":["DEEPINFRA_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://deepinfra.com/models"},
    {"id":"deepseek","name":"DeepSeek","env":["DEEPSEEK_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.deepseek.com","doc":"https://api-docs.deepseek.com/quick_start/pricing"},
    {"id":"llmgateway","name":"DevPass (LLM Gateway)","env":["LLMGATEWAY_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.llmgateway.io/v1","doc":"https://llmgateway.io/docs"},
    {"id":"digitalocean","name":"DigitalOcean","env":["DIGITALOCEAN_ACCESS_TOKEN"],"protocol":"openai-completions","baseURL":"https://inference.do-ai.run/v1","doc":"https://docs.digitalocean.com/products/gradient-ai-platform/details/models/"},
    {"id":"dinference","name":"DInference","env":["DINFERENCE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.dinference.com/v1","doc":"https://dinference.com"},
    {"id":"ebcloud","name":"EBCloud","env":["EBCLOUD_API_KEY"],"protocol":"openai-completions","baseURL":"https://maas-api.ebcloud.com/v1","doc":"https://docs.ebtech.com/ai/model-api.html"},
    {"id":"echo","name":"Echo","env":["ECHO_API_KEY"],"protocol":"openai-completions","baseURL":"https://echo.tracerml.ai/v1","doc":"https://echo.tracerml.ai/docs/api"},
    {"id":"edenai","name":"Eden AI","env":["EDENAI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.edenai.run/v3","doc":"https://docs.edenai.co"},
    {"id":"empiriolabs","name":"EmpirioLabs AI","env":["EMPIRIOLABS_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.empiriolabs.ai/v1","doc":"https://docs.empiriolabs.ai"},
    {"id":"evroc","name":"evroc","env":["EVROC_API_KEY"],"protocol":"openai-completions","baseURL":"https://models.think.evroc.com/v1","doc":"https://docs.evroc.com/products/think/overview.html"},
    {"id":"fastrouter","name":"FastRouter","env":["FASTROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://go.fastrouter.ai/api/v1","doc":"https://fastrouter.ai/models"},
    {"id":"fireworks-ai","name":"Fireworks AI","env":["FIREWORKS_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.fireworks.ai/inference/v1/","doc":"https://fireworks.ai/docs/"},
    {"id":"freemodel","name":"FreeModel","env":["FREEMODEL_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://cc.freemodel.dev/v1","doc":"https://freemodel.dev"},
    {"id":"friendli","name":"Friendli","env":["FRIENDLI_TOKEN"],"protocol":"openai-completions","baseURL":"https://api.friendli.ai/serverless/v1","doc":"https://friendli.ai/docs/guides/serverless_endpoints/introduction"},
    {"id":"frogbot","name":"FrogBot","env":["FROGBOT_API_KEY"],"protocol":"openai-completions","baseURL":"https://app.frogbot.ai/api/v1","doc":"https://docs.frogbot.ai"},
    {"id":"github-copilot","name":"GitHub Copilot","env":["GITHUB_TOKEN"],"protocol":"openai-completions","baseURL":"https://api.githubcopilot.com","doc":"https://docs.github.com/en/copilot"},
    {"id":"gitlab","name":"GitLab Duo","env":["GITLAB_TOKEN"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.gitlab.com/user/duo_agent_platform/"},
    {"id":"gmicloud","name":"GMI Cloud","env":["GMICLOUD_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.gmi-serving.com/v1","doc":"https://docs.gmicloud.ai/inference-engine/api-reference/llm-api-reference"},
    {"id":"google","name":"Google","env":["GOOGLE_API_KEY","GOOGLE_GENERATIVE_AI_API_KEY","GEMINI_API_KEY"],"protocol":"openai-completions","baseURL":"https://generativelanguage.googleapis.com/v1beta","doc":"https://ai.google.dev/gemini-api/docs/models"},
    {"id":"greenpt","name":"GreenPT","env":["GREENPT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.greenpt.ai/v1","doc":"https://docs.greenpt.ai"},
    {"id":"groq","name":"Groq","env":["GROQ_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.groq.com/openai/v1","doc":"https://console.groq.com/docs/models"},
    {"id":"helicone","name":"Helicone","env":["HELICONE_API_KEY"],"protocol":"openai-completions","baseURL":"https://ai-gateway.helicone.ai/v1","doc":"https://helicone.ai/models"},
    {"id":"hetzner","name":"Hetzner","env":["HETZNER_API_KEY"],"protocol":"openai-completions","baseURL":"https://inference.hetzner.com/api/v1","doc":"https://experiments.hetzner.com/docs/inference"},
    {"id":"hpc-ai","name":"HPC-AI","env":["HPC_AI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.hpc-ai.com/inference/v1","doc":"https://www.hpc-ai.com/doc/docs/quickstart/"},
    {"id":"huggingface","name":"Hugging Face","env":["HF_TOKEN"],"protocol":"openai-completions","baseURL":"https://router.huggingface.co/v1","doc":"https://huggingface.co/docs/inference-providers"},
    {"id":"iflowcn","name":"iFlow","env":["IFLOW_API_KEY"],"protocol":"openai-completions","baseURL":"https://apis.iflow.cn/v1","doc":"https://platform.iflow.cn/en/docs"},
    {"id":"impossibl","name":"Impossibl","env":["IMPOSSIBL_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.impossibl.com/v1","doc":"https://impossibl.com/docs/models"},
    {"id":"inception","name":"Inception","env":["INCEPTION_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.inceptionlabs.ai/v1/","doc":"https://platform.inceptionlabs.ai/docs"},
    {"id":"inceptron","name":"Inceptron","env":["INCEPTRON_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.inceptron.io/v1","doc":"https://docs.inceptron.io"},
    {"id":"inference","name":"Inference","env":["INFERENCE_API_KEY"],"protocol":"openai-completions","baseURL":"https://inference.net/v1","doc":"https://inference.net/models"},
    {"id":"inferx","name":"InferX","env":["INFERX_API_KEY"],"protocol":"openai-completions","baseURL":"https://model.inferx.net/endpoints/v1","doc":"https://model.inferx.net/endpoints"},
    {"id":"infomaniak","name":"Infomaniak","env":["INFOMANIAK_API_KEY","INFOMANIAK_PRODUCT_ID"],"protocol":"openai-completions","baseURL":"https://api.infomaniak.com/2/ai/{env:INFOMANIAK_PRODUCT_ID}/openai/v1","doc":"https://www.infomaniak.com/en/hosting/ai-services/open-source-models"},
    {"id":"io-net","name":"IO.NET","env":["IOINTELLIGENCE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.intelligence.io.solutions/api/v1","doc":"https://io.net/docs/guides/intelligence/io-intelligence"},
    {"id":"iteracompute","name":"IteraCompute","env":["ITERACOMPUTE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.iteracompute.com/v1","doc":"https://iteracompute.com/docs.html"},
    {"id":"jalapeno","name":"Jalapeno Cloud","env":["JALAPENO_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.jalapeno-cloud.ai/v1","doc":"https://www.jalapeno-cloud.ai/docs/"},
    {"id":"jiekou","name":"Jiekou.AI","env":["JIEKOU_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.jiekou.ai/openai","doc":"https://docs.jiekou.ai/docs/support/quickstart?utm_source=github_models.dev"},
    {"id":"kenari","name":"Kenari","env":["KENARI_API_KEY"],"protocol":"openai-completions","baseURL":"https://kenari.id/v1","doc":"https://kenari.id/docs"},
    {"id":"kilo","name":"Kilo Gateway","env":["KILO_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.kilo.ai/api/gateway","doc":"https://kilo.ai"},
    {"id":"kimi-for-coding","name":"Kimi For Coding","env":["KIMI_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.kimi.com/coding/v1","doc":"https://www.kimi.com/code/docs/en/third-party-tools/other-coding-agents.html"},
    {"id":"klokintegration","name":"klokintegration.se","env":["KLOKINTEGRATION_API_KEY"],"protocol":"openai-completions","baseURL":"https://api-gw.klok.ipaas.se/proxy/kloker-key/v1","doc":"https://klokintegration.se/docs/ai-api"},
    {"id":"kosmik","name":"Kosmik Compute","env":["KOSMIK_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.koscompute.com/v1","doc":"https://api.koscompute.com/docs/"},
    {"id":"kuae-cloud-coding-plan","name":"KUAE Cloud Coding Plan","env":["KUAE_API_KEY"],"protocol":"openai-completions","baseURL":"https://coding-plan-endpoint.kuaecloud.net/v1","doc":"https://docs.mthreads.com/kuaecloud/kuaecloud-doc-online/coding_plan/"},
    {"id":"lilac","name":"Lilac","env":["LILAC_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.getlilac.com/v1","doc":"https://docs.getlilac.com/inference/models"},
    {"id":"llama","name":"Llama","env":["LLAMA_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.llama.com/compat/v1/","doc":"https://llama.developer.meta.com/docs/models"},
    {"id":"llmgateway-providers","name":"LLM Gateway","env":["LLMGATEWAY_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.llmgateway.io/v1","doc":"https://llmgateway.io/docs"},
    {"id":"llmtech","name":"LLM Tech","env":["LLMTECH_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.llmtech.eu/v1","doc":"https://llmtech.eu/models/qwen3.8-27b"},
    {"id":"llmtr","name":"LLMTR","env":["LLMTR_API_KEY"],"protocol":"openai-completions","baseURL":"https://llmtr.com/v1","doc":"https://llmtr.com/docs"},
    {"id":"lmstudio","name":"LMStudio","env":["LMSTUDIO_API_KEY"],"protocol":"openai-completions","baseURL":"http://127.0.0.1:1234/v1","doc":"https://lmstudio.ai/models"},
    {"id":"longcat","name":"LongCat","env":["LONGCAT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.longcat.chat/openai","doc":"https://longcat.chat/platform/docs/"},
    {"id":"lucidquery","name":"LucidQuery","env":["LUCIDQUERY_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.lucidquery.com/v1","doc":"https://lucidquery.com/docs"},
    {"id":"lynkr","name":"Lynkr","env":["LYNKR_API_KEY"],"protocol":"openai-completions","baseURL":"http://127.0.0.1:8081/v1","doc":"https://github.com/Fast-Editor/Lynkr"},
    {"id":"meganova","name":"Meganova","env":["MEGANOVA_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.meganova.ai/v1","doc":"https://docs.meganova.ai"},
    {"id":"merge-gateway","name":"Merge Gateway","env":["MERGE_GATEWAY_API_KEY"],"protocol":"openai-completions","baseURL":"https://api-gateway.merge.dev/v1/ai-sdk","doc":"https://docs.merge.dev/merge-gateway"},
    {"id":"meta","name":"Meta","env":["META_MODEL_API_KEY"],"protocol":"openai-responses","baseURL":"https://api.meta.ai/v1","doc":"https://dev.meta.ai/docs"},
    {"id":"minimax","name":"MiniMax (minimax.io)","env":["MINIMAX_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.minimax.io/anthropic/v1","doc":"https://platform.minimax.io/docs/guides/quickstart"},
    {"id":"minimax-cn","name":"MiniMax (minimaxi.com)","env":["MINIMAX_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.minimaxi.com/anthropic/v1","doc":"https://platform.minimaxi.com/docs/guides/quickstart"},
    {"id":"minimax-coding-plan","name":"MiniMax Token Plan (minimax.io)","env":["MINIMAX_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.minimax.io/anthropic/v1","doc":"https://platform.minimax.io/docs/token-plan/intro"},
    {"id":"minimax-cn-coding-plan","name":"MiniMax Token Plan (minimaxi.com)","env":["MINIMAX_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.minimaxi.com/anthropic/v1","doc":"https://platform.minimaxi.com/docs/token-plan/intro"},
    {"id":"mistral","name":"Mistral","env":["MISTRAL_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.mistral.ai","doc":"https://docs.mistral.ai/getting-started/models/"},
    {"id":"mixlayer","name":"Mixlayer","env":["MIXLAYER_API_KEY"],"protocol":"openai-completions","baseURL":"https://models.mixlayer.ai/v1","doc":"https://docs.mixlayer.com"},
    {"id":"moark","name":"Moark","env":["MOARK_API_KEY"],"protocol":"openai-completions","baseURL":"https://moark.com/v1","doc":"https://moark.com/docs/openapi/v1#tag/%E6%96%87%E6%9C%AC%E7%94%9F%E6%88%90"},
    {"id":"modal","name":"Modal","env":["MODAL_PROXY_TOKEN"],"protocol":"openai-completions","baseURL":"https://inference.us-west.modal.direct/v1","doc":"https://modal.com/docs/guide/endpoints"},
    {"id":"model-oracle-ai","name":"Model Oracle AI","env":["MODEL_ORACLE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.modeloracle.com/api/v1","doc":"https://modeloracle.com/setup/"},
    {"id":"modelis","name":"Modelis","env":["MODELIS_API_KEY"],"protocol":"openai-completions","baseURL":"https://modelishub.com/v1","doc":"https://modelishub.com/pricing"},
    {"id":"modelscope","name":"ModelScope","env":["MODELSCOPE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api-inference.modelscope.cn/v1","doc":"https://modelscope.cn/docs/model-service/API-Inference/intro"},
    {"id":"moonshotai","name":"Moonshot AI","env":["MOONSHOT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.moonshot.ai/v1","doc":"https://platform.moonshot.ai/docs/api/chat"},
    {"id":"moonshotai-cn","name":"Moonshot AI (China)","env":["MOONSHOT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.moonshot.cn/v1","doc":"https://platform.moonshot.cn/docs/api/chat"},
    {"id":"morph","name":"Morph","env":["MORPH_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.morphllm.com/v1","doc":"https://docs.morphllm.com/api-reference/introduction"},
    {"id":"nano-gpt","name":"NanoGPT","env":["NANO_GPT_API_KEY"],"protocol":"openai-completions","baseURL":"https://nano-gpt.com/api/v1","doc":"https://docs.nano-gpt.com"},
    {"id":"nearai","name":"NEAR AI Cloud","env":["NEARAI_API_KEY"],"protocol":"openai-completions","baseURL":"https://cloud-api.near.ai/v1","doc":"https://docs.near.ai/"},
    {"id":"nebius","name":"Nebius Token Factory","env":["NEBIUS_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.tokenfactory.nebius.com/v1","doc":"https://docs.tokenfactory.nebius.com/"},
    {"id":"neon","name":"Neon","env":["NEON_AI_GATEWAY_BASE_URL","NEON_AI_GATEWAY_TOKEN"],"protocol":"openai-completions","baseURL":"{env:NEON_AI_GATEWAY_BASE_URL}/v1","doc":"https://neon.com/docs"},
    {"id":"neosmith","name":"NeoSmith","env":["NEOSMITH_API_KEY"],"protocol":"openai-responses","baseURL":"https://router.neosmith.ai/v1","doc":"https://neosmith.ai/docs"},
    {"id":"neuralwatt","name":"Neuralwatt","env":["NEURALWATT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.neuralwatt.com/v1","doc":"https://portal.neuralwatt.com/docs"},
    {"id":"nova","name":"Nova","env":["NOVA_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.nova.amazon.com/v1","doc":"https://nova.amazon.com/dev/documentation"},
    {"id":"novita-ai","name":"NovitaAI","env":["NOVITA_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.novita.ai/openai","doc":"https://novita.ai/docs/guides/introduction"},
    {"id":"nvidia","name":"Nvidia","env":["NVIDIA_API_KEY"],"protocol":"openai-completions","baseURL":"https://integrate.api.nvidia.com/v1","doc":"https://docs.api.nvidia.com/nim/"},
    {"id":"ofox","name":"Ofox","env":["OFOX_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.ofox.ai/v1","doc":"https://ofox.ai/docs"},
    {"id":"ollama","name":"Ollama (Local)","env":["OLLAMA_API_KEY"],"protocol":"openai-completions","baseURL":"http://127.0.0.1:11434/v1","doc":"https://ollama.com"},
    {"id":"ollama-cloud","name":"Ollama Cloud","env":["OLLAMA_API_KEY"],"protocol":"openai-completions","baseURL":"https://ollama.com/v1","doc":"https://docs.ollama.com/cloud"},
    {"id":"openai","name":"OpenAI","env":["OPENAI_API_KEY"],"protocol":"openai-responses","baseURL":"https://api.openai.com/v1","doc":"https://platform.openai.com/docs/models"},
    {"id":"opencode-go","name":"OpenCode Go","env":["OPENCODE_API_KEY"],"protocol":"openai-completions","baseURL":"https://opencode.ai/zen/go/v1","doc":"https://opencode.ai/docs/zen"},
    {"id":"opencode","name":"OpenCode Zen","env":["OPENCODE_API_KEY"],"protocol":"openai-completions","baseURL":"https://opencode.ai/zen/v1","doc":"https://opencode.ai/docs/zen"},
    {"id":"openreason","name":"OpenReason","env":["OPENREASON_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.openreason.app/v1","doc":"https://openreason.app/docs"},
    {"id":"openrouter","name":"OpenRouter","env":["OPENROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://openrouter.ai/api/v1","doc":"https://openrouter.ai/models"},
    {"id":"opper","name":"Opper","env":["OPPER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.opper.ai/v3/compat","doc":"https://opper.ai/models"},
    {"id":"orcarouter","name":"OrcaRouter","env":["ORCAROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.orcarouter.ai/v1","doc":"https://docs.orcarouter.ai"},
    {"id":"ovhcloud","name":"OVHcloud AI Endpoints","env":["OVHCLOUD_API_KEY"],"protocol":"openai-completions","baseURL":"https://oai.endpoints.kepler.ai.cloud.ovh.net/v1","doc":"https://www.ovhcloud.com/en/public-cloud/ai-endpoints/catalog//"},
    {"id":"pendra","name":"Pendra","env":["PENDRA_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.pendra.ai/api/v1","doc":"https://pendra.ai/docs/integrations/opencode"},
    {"id":"perplexity","name":"Perplexity","env":["PERPLEXITY_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.perplexity.ai"},
    {"id":"perplexity-agent","name":"Perplexity Agent","env":["PERPLEXITY_API_KEY"],"protocol":"openai-responses","baseURL":"https://api.perplexity.ai/v1","doc":"https://docs.perplexity.ai/docs/agent-api/models"},
    {"id":"pioneer","name":"Pioneer","env":["PIONEER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.pioneer.ai/v1","doc":"https://agent.pioneer.ai/llms.txt"},
    {"id":"poe","name":"Poe","env":["POE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.poe.com/v1","doc":"https://creator.poe.com/docs/external-applications/openai-compatible-api"},
    {"id":"poolside","name":"Poolside","env":["POOLSIDE_API_KEY"],"protocol":"openai-completions","baseURL":"https://inference.poolside.ai/v1","doc":"https://platform.poolside.ai"},
    {"id":"privatemode-ai","name":"Privatemode AI","env":["PRIVATEMODE_API_KEY","PRIVATEMODE_ENDPOINT"],"protocol":"openai-completions","baseURL":"http://localhost:8080/v1","doc":"https://docs.privatemode.ai/api/overview"},
    {"id":"qihang-ai","name":"QiHang","env":["QIHANG_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.qhaigc.net/v1","doc":"https://www.qhaigc.net/docs"},
    {"id":"qiniu-ai","name":"Qiniu","env":["QINIU_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.qnaigc.com/v1","doc":"https://developer.qiniu.com/aitokenapi"},
    {"id":"qvac","name":"QVAC","env":["QVAC_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://www.npmjs.com/package/@qvac/ai-sdk-provider"},
    {"id":"regolo-ai","name":"Regolo AI","env":["REGOLO_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.regolo.ai/v1","doc":"https://docs.regolo.ai/"},
    {"id":"requesty","name":"Requesty","env":["REQUESTY_API_KEY"],"protocol":"openai-completions","baseURL":"https://router.requesty.ai/v1","doc":"https://requesty.ai/solution/llm-routing/models"},
    {"id":"routing-run","name":"routing.run","env":["ROUTING_RUN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.routing.run/v1","doc":"https://docs.routing.run/api-reference/models"},
    {"id":"runinfra","name":"RunInfra","env":["RUNINFRA_GATEWAY_KEY"],"protocol":"openai-completions","baseURL":"https://api.runinfra.ai/v1","doc":"https://runinfra.ai/docs"},
    {"id":"sakana","name":"Sakana AI","env":["SAKANA_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.sakana.ai/v1","doc":"https://console.sakana.ai/models"},
    {"id":"salad-cloud","name":"SaladCloud AI Gateway","env":["SALAD_CLOUD_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.salad.com/ai-gateway/explanation/overview"},
    {"id":"sap-ai-core","name":"SAP AI Core","env":["AICORE_SERVICE_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://help.sap.com/docs/sap-ai-core"},
    {"id":"sarvam","name":"Sarvam AI","env":["SARVAM_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.sarvam.ai/v1","doc":"https://docs.sarvam.ai/api-reference-docs/getting-started/models"},
    {"id":"scaleway","name":"Scaleway","env":["SCALEWAY_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.scaleway.ai/v1","doc":"https://www.scaleway.com/en/docs/generative-apis/"},
    {"id":"scnet-token-plan","name":"SCNet Token Plan","env":["SCNET_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.scnet.cn/api/llm/v1","doc":"https://www.scnet.cn/ac/openapi/doc/2.0/moduleapi/plans/token-plan.html"},
    {"id":"scx-ai","name":"SCX.ai","env":["SCX_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.scx.ai/v1","doc":"https://platform.scx.ai/docs"},
    {"id":"siliconflow","name":"SiliconFlow","env":["SILICONFLOW_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.siliconflow.com/v1","doc":"https://cloud.siliconflow.com/models"},
    {"id":"siliconflow-cn","name":"SiliconFlow (China)","env":["SILICONFLOW_CN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.siliconflow.cn/v1","doc":"https://cloud.siliconflow.com/models"},
    {"id":"snowflake-cortex","name":"Snowflake Cortex","env":["SNOWFLAKE_ACCOUNT","SNOWFLAKE_CORTEX_PAT"],"protocol":"openai-completions","baseURL":"https://{env:SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1","doc":"https://docs.snowflake.com/en/user-guide/snowflake-cortex/cortex-rest-api"},
    {"id":"stackit","name":"STACKIT","env":["STACKIT_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1","doc":"https://docs.stackit.cloud/products/data-and-ai/ai-model-serving/basics/available-shared-models"},
    {"id":"standardcompute","name":"Standard Compute","env":["STANDARDCOMPUTE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.stdcmpt.com/v1","doc":"https://standardcompute.com/models"},
    {"id":"stepfun","name":"StepFun (China)","env":["STEPFUN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.stepfun.com/v1","doc":"https://platform.stepfun.com/docs/zh/overview/concept"},
    {"id":"stepfun-ai","name":"StepFun (Global)","env":["STEPFUN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.stepfun.ai/v1","doc":"https://platform.stepfun.ai/docs/en/overview/concept"},
    {"id":"stepfun-step-plan","name":"StepFun Step Plan (China)","env":["STEPFUN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.stepfun.com/step_plan/v1","doc":"https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api"},
    {"id":"stepfun-ai-step-plan","name":"StepFun Step Plan (Global)","env":["STEPFUN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.stepfun.ai/step_plan/v1","doc":"https://platform.stepfun.ai/docs/en/step-plan/integrations/reasoning-api"},
    {"id":"subconscious","name":"Subconscious","env":["SUBCONSCIOUS_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://api.subconscious.dev/v1","doc":"https://docs.subconscious.dev"},
    {"id":"submodel","name":"submodel","env":["SUBMODEL_INSTAGEN_ACCESS_KEY"],"protocol":"openai-completions","baseURL":"https://llm.submodel.ai/v1","doc":"https://submodel.gitbook.io"},
    {"id":"synthetic","name":"Synthetic","env":["SYNTHETIC_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.synthetic.new/openai/v1","doc":"https://synthetic.new/pricing"},
    {"id":"tencent-coding-plan","name":"Tencent Coding Plan (China)","env":["TENCENT_CODING_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.lkeap.cloud.tencent.com/coding/v3","doc":"https://cloud.tencent.com/document/product/1772/128947"},
    {"id":"tencent-token-plan","name":"Tencent Token Plan","env":["TENCENT_TOKEN_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.lkeap.cloud.tencent.com/plan/v3","doc":"https://cloud.tencent.com/document/product/1823/130060"},
    {"id":"tencent-tokenhub","name":"Tencent TokenHub","env":["TENCENT_TOKENHUB_API_KEY"],"protocol":"openai-completions","baseURL":"https://tokenhub.tencentmaas.com/v1","doc":"https://cloud.tencent.com/document/product/1823/130050"},
    {"id":"tensorx","name":"TensorX","env":["TENSORX_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.tensorx.ai/v1","doc":"https://docs.tensorx.ai/"},
    {"id":"the-grid-ai","name":"The Grid AI","env":["THEGRID_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.thegrid.ai/v1","doc":"https://thegrid.ai/docs"},
    {"id":"thinkingmachines","name":"Thinking Machines","env":["TINKER_API_KEY"],"protocol":"anthropic-messages","baseURL":"https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1","doc":"https://tinker-docs.thinkingmachines.ai/tinker/compatible-apis/anthropic/"},
    {"id":"tinfoil","name":"Tinfoil","env":["TINFOIL_API_KEY"],"protocol":"openai-completions","baseURL":"https://inference.tinfoil.sh/v1","doc":"https://docs.tinfoil.sh"},
    {"id":"togetherai","name":"Together AI","env":["TOGETHER_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.together.ai/docs/serverless-models"},
    {"id":"tokengo","name":"TokenGo","env":["TOKENGO_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.tokengo.com/v1","doc":"https://www.tokengo.com/docs"},
    {"id":"tokenrouter","name":"TokenRouter","env":["TOKENROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.tokenrouter.com/v1","doc":"https://www.tokenrouter.com/docs/tokenrouter-feature-guide/"},
    {"id":"trustedrouter","name":"TrustedRouter","env":["TRUSTEDROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.trustedrouter.com/v1","doc":"https://trustedrouter.com/docs"},
    {"id":"umans-ai","name":"Umans AI","env":["UMANS_AI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.code.umans.ai/v1","doc":"https://app.umans.ai/offers/code/docs/orgs"},
    {"id":"umans-ai-coding-plan","name":"Umans AI Coding Plan","env":["UMANS_AI_CODING_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.code.umans.ai/v1","doc":"https://app.umans.ai/offers/code/docs"},
    {"id":"unorouter","name":"UnoRouter","env":["UNOROUTER_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.unorouter.com/v1","doc":"https://unorouter.com/models"},
    {"id":"upstage","name":"Upstage","env":["UPSTAGE_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.upstage.ai/v1/solar","doc":"https://developers.upstage.ai/docs/apis/chat"},
    {"id":"v0","name":"v0","env":["V0_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://sdk.vercel.ai/providers/ai-sdk-providers/vercel"},
    {"id":"vancine","name":"Vancine","env":["VANCINE_API_KEY"],"protocol":"openai-completions","baseURL":"https://vancine.com/v1","doc":"https://vancine.com/docs"},
    {"id":"venice","name":"Venice AI","env":["VENICE_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://docs.venice.ai"},
    {"id":"vercel","name":"Vercel AI Gateway","env":["AI_GATEWAY_API_KEY"],"protocol":"openai-completions","baseURL":"","doc":"https://github.com/vercel/ai/tree/5eb85cc45a259553501f535b8ac79a77d0e79223/packages/gateway"},
    {"id":"google-vertex","name":"Vertex","env":["GOOGLE_VERTEX_PROJECT","GOOGLE_VERTEX_LOCATION","GOOGLE_APPLICATION_CREDENTIALS"],"protocol":"openai-completions","baseURL":"https://{location}-aiplatform.googleapis.com","doc":"https://cloud.google.com/vertex-ai/generative-ai/docs/models"},
    {"id":"google-vertex-anthropic","name":"Vertex (Anthropic)","env":["GOOGLE_VERTEX_PROJECT","GOOGLE_VERTEX_LOCATION","GOOGLE_APPLICATION_CREDENTIALS"],"protocol":"anthropic-messages","baseURL":"","doc":"https://cloud.google.com/vertex-ai/generative-ai/docs/partner-models/claude"},
    {"id":"vivgrid","name":"Vivgrid","env":["VIVGRID_API_KEY"],"protocol":"openai-responses","baseURL":"https://api.vivgrid.com/v1","doc":"https://docs.vivgrid.com/models"},
    {"id":"volcengine","name":"Volcengine Ark","env":["ARK_API_KEY"],"protocol":"openai-completions","baseURL":"https://ark.cn-beijing.volces.com/api/v3","doc":"https://www.volcengine.com/docs/82379/1330310"},
    {"id":"volcengine-coding-plan","name":"Volcengine Ark Coding Plan","env":["ARK_CODING_PLAN_API_KEY"],"protocol":"openai-completions","baseURL":"https://ark.cn-beijing.volces.com/api/coding/v3","doc":"https://www.volcengine.com/docs/82379/1928261"},
    {"id":"vultr","name":"Vultr","env":["VULTR_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.vultrinference.com/v1","doc":"https://api.vultrinference.com/"},
    {"id":"wafer.ai","name":"Wafer","env":["WAFER_API_KEY"],"protocol":"openai-completions","baseURL":"https://pass.wafer.ai/v1","doc":"https://docs.wafer.ai/wafer-pass"},
    {"id":"watsonx","name":"watsonx.ai","env":["WATSONX_AI_APIKEY","WATSONX_AI_PROJECT_ID"],"protocol":"openai-completions","baseURL":"","doc":"https://www.ibm.com/docs/en/watsonx/saas?topic=solutions-supported-foundation-models"},
    {"id":"wandb","name":"Weights & Biases","env":["WANDB_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.inference.wandb.ai/v1","doc":"https://docs.wandb.ai/guides/integrations/inference/"},
    {"id":"xai","name":"xAI","env":["XAI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.x.ai/v1","doc":"https://docs.x.ai/docs/models"},
    {"id":"xiaomi","name":"Xiaomi","env":["XIAOMI_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.xiaomimimo.com/v1","doc":"https://platform.xiaomimimo.com/#/docs"},
    {"id":"xiaomi-token-plan-cn","name":"Xiaomi Token Plan (China)","env":["XIAOMI_API_KEY"],"protocol":"openai-completions","baseURL":"https://token-plan-cn.xiaomimimo.com/v1","doc":"https://platform.xiaomimimo.com/#/docs"},
    {"id":"xiaomi-token-plan-ams","name":"Xiaomi Token Plan (Europe)","env":["XIAOMI_API_KEY"],"protocol":"openai-completions","baseURL":"https://token-plan-ams.xiaomimimo.com/v1","doc":"https://platform.xiaomimimo.com/#/docs"},
    {"id":"xiaomi-token-plan-sgp","name":"Xiaomi Token Plan (Singapore)","env":["XIAOMI_API_KEY"],"protocol":"openai-completions","baseURL":"https://token-plan-sgp.xiaomimimo.com/v1","doc":"https://platform.xiaomimimo.com/#/docs"},
    {"id":"xpersona","name":"Xpersona","env":["XPERSONA_API_KEY"],"protocol":"openai-completions","baseURL":"https://www.xpersona.co/v1","doc":"https://www.xpersona.co/docs"},
    {"id":"zai","name":"Z.AI","env":["ZHIPU_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.z.ai/api/paas/v4","doc":"https://docs.z.ai/guides/overview/pricing"},
    {"id":"zai-coding-plan","name":"Z.AI Coding Plan","env":["ZHIPU_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.z.ai/api/coding/paas/v4","doc":"https://docs.z.ai/devpack/overview"},
    {"id":"zeldoc","name":"Zeldoc","env":["ZELDOC_API_KEY"],"protocol":"openai-completions","baseURL":"https://api.zeldoc.ai/v1","doc":"https://docs.zeldoc.ai"},
    {"id":"zenifra","name":"Zenifra","env":["ZENIFRA_AI_KEY"],"protocol":"openai-completions","baseURL":"https://ai.zenifra.com/v1","doc":"https://docs.zenifra.com"},
    {"id":"zenmux","name":"ZenMux","env":["ZENMUX_API_KEY"],"protocol":"openai-completions","baseURL":"https://zenmux.ai/api/v1","doc":"https://docs.zenmux.ai"},
    {"id":"zhipuai","name":"Zhipu AI","env":["ZHIPU_API_KEY"],"protocol":"openai-completions","baseURL":"https://open.bigmodel.cn/api/paas/v4","doc":"https://docs.z.ai/guides/overview/pricing"},
    {"id":"zhipuai-coding-plan","name":"Zhipu AI Coding Plan","env":["ZHIPU_API_KEY"],"protocol":"openai-completions","baseURL":"https://open.bigmodel.cn/api/coding/paas/v4","doc":"https://docs.bigmodel.cn/cn/coding-plan/overview"},
  ]

  // Demo-only simulation facts for Kilo: the shipped preset list marks it
  // keyless through KEYLESS_PRESET_IDS; discovery count and model are samples.
  const PROVIDER_EXTRAS = { kilo: { keyless: true, models: 5, model: 'kilo-auto/free' } }

  const PROVIDERS = Object.fromEntries(
    CATALOGUE.map((p) => [p.id, { ...p, ...(PROVIDER_EXTRAS[p.id] || {}) }]),
  )

  // OpenCode's popular ordering (provider-templates.ts POPULAR_PROVIDERS).
  const POPULAR_PROVIDERS = ['opencode', 'opencode-go', 'anthropic', 'github-copilot', 'openai', 'google', 'openrouter', 'vercel']

  // The pre-connection heavy rows (heavy-providers.ts fallback table).
  const HEAVY_ROWS = [
    { id: 'freellmapi', name: 'FreeLLMAPI' },
    { id: 'antigravity', name: 'Antigravity Proxy' },
    { id: 'commandcode', name: 'Command Code' },
  ]

  // FreeLLMAPI's platform variants (HeavyProviderDocs' install table, verbatim).
  // Linux has no override: it resolves the shared engine-aware compose path.
  const FREELLMAPI_PLATFORMS = {
    linux: {
      label: 'Install locally (Docker or Podman)',
      deps: 'Docker Engine or Podman, with Compose',
      disk: '~700 MB disk (536 MB image), ~84 MB RAM idle, no GPU',
      steps: [
        { label: 'Clone FreeLLMAPI', command: 'test -d {home}/freellmapi/.git || git clone --depth 1 https://github.com/tashfeenahmed/freellmapi {home}/freellmapi' },
        { label: 'Generate ENCRYPTION_KEY', command: 'test -f {home}/freellmapi/.env || printf "ENCRYPTION_KEY=%s\\nPORT=3002\\nHOST_BIND=127.0.0.1\\n" "$(openssl rand -hex 32)" > {home}/freellmapi/.env' },
        { label: 'Start the stack', command: 'ENGINE="$(command -v docker || command -v podman)"; test -n "$ENGINE" || { echo "neither docker nor podman is installed"; exit 1; }; "$ENGINE" compose up -d' },
        { label: 'Wait for the gateway', command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1' },
      ],
    },
    darwin: {
      label: 'Install locally (vendor desktop app, no Docker)',
      deps: 'macOS 11+',
      disk: '~250 MB app; data in ~/Library/Application Support/FreeLLMAPI',
      steps: [
        { label: 'Download the latest .dmg', command: 'arch="$(uname -m)"; test "$arch" = arm64 || arch=x64; url="$(curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\'"$arch"\'[.]dmg"\' | head -1 | cut -d\'"\' -f4)"; test -n "$url" || { echo "no FreeLLMAPI $arch .dmg in the latest release"; exit 1; }; mkdir -p {home}/Downloads && curl -fsSL -o {home}/Downloads/FreeLLMAPI.dmg "$url"' },
        { label: 'Install the app from the disk image', command: 'mkdir -p /tmp/freellmapi-dmg && hdiutil attach {home}/Downloads/FreeLLMAPI.dmg -nobrowse -quiet -mountpoint /tmp/freellmapi-dmg && cp -R /tmp/freellmapi-dmg/*.app /Applications/ && hdiutil detach /tmp/freellmapi-dmg -quiet' },
        { label: 'Pin the desktop app to port 3002', command: 'mkdir -p {home}/Library/Application\\ Support/FreeLLMAPI && printf \'{"port":3002}\\n\' > {home}/Library/Application\\ Support/FreeLLMAPI/config.json' },
        { label: 'Launch FreeLLMAPI', command: 'open -a FreeLLMAPI' },
        { label: 'Wait for the gateway', command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1' },
      ],
    },
    win32: {
      label: 'Install locally (vendor desktop app, no Docker)',
      deps: 'Windows 10+',
      disk: '~250 MB app; data in %APPDATA%\\FreeLLMAPI',
      steps: [
        { label: 'Download the latest installer', command: 'mkdir -p {home}/Downloads && curl -fsSL https://api.github.com/repos/tashfeenahmed/freellmapi/releases/latest | grep -oE \'"browser_download_url": *"[^"]+\\.exe"\' | head -1 | cut -d\'"\' -f4 | xargs -I{} curl -fsSL -o {home}/Downloads/FreeLLMAPI-Setup.exe {}' },
        { label: 'Install silently', command: 'cmd //c start //wait "" "$HOME/Downloads/FreeLLMAPI-Setup.exe" /S' },
        { label: 'Pin the desktop app to port 3002', command: 'mkdir -p "$APPDATA/FreeLLMAPI" && printf \'{"port":3002}\\n\' > "$APPDATA/FreeLLMAPI/config.json"' },
        { label: 'Launch FreeLLMAPI', command: 'cmd //c start "" "$LOCALAPPDATA\\Programs\\FreeLLMAPI\\FreeLLMAPI.exe"' },
        { label: 'Wait for the gateway', command: 'for i in $(seq 1 60); do curl -fsS http://127.0.0.1:3002/api/ping >/dev/null && exit 0; sleep 2; done; echo "gateway did not answer within 120s"; exit 1' },
      ],
    },
  }

  const state = {
    step: 1,
    stop: 0,
    inTour: false,
    analysis: 'idle', // idle | running | done
    sandbox: 'workspace-write',
    toggles: { compaction: true, keeper: true, whiteboard: true },
    compactionMode: 'llm',
    provider: 'kilo',
    providerView: 'picker',
    providerOpen: false,
    providerCreated: false,
    providerRunning: false,
    choices: {}, // step -> 'done' (configured) | 'default' (accepted defaults) | 'skipped' (explicit)
    finished: false,
  }

  const timers = []
  const later = (fn, ms) => {
    const id = setTimeout(fn, ms)
    timers.push(id)
    return id
  }
  const clearTimers = () => {
    while (timers.length) clearTimeout(timers.pop())
  }

  const body = document.body
  const wizard = $('#wizard')
  const panelScroll = $('#panelScroll')
  const stepCount = $('#stepCount')
  const footDots = $('#footDots')
  const spot = $('#spot')
  const spotHole = $('#spotHole')
  const spotTip = $('#spotTip')
  const tipCount = $('#tipCount')
  const tipTitle = $('#tipTitle')
  const tipBody = $('#tipBody')
  const dock = $('#dock')
  const dockLines = $('#dockLines')
  const dockTitle = $('#dockTitle')
  const dockFoot = $('#dockFoot')
  const dockTag = $('#dockTag')
  const toastEl = $('#toast')
  const helpMask = $('#helpMask')
  const doneToast = $('#doneToast')
  const offerStatus = $('#offerStatus')
  const offerActions = $('#offerActions')

  let toastTimer = null

  function toast(text) {
    toastEl.textContent = text
    toastEl.hidden = false
    clearTimeout(toastTimer)
    toastTimer = setTimeout(() => { toastEl.hidden = true }, 2600)
  }

  // ── Wizard rendering ──────────────────────────────────────────────────────

  function render() {
    const step = state.step
    $$('.step').forEach((el) => { el.hidden = Number(el.dataset.step) !== step })
    $$('#stepList li').forEach((li) => {
      const n = Number(li.dataset.jump)
      const choice = state.choices[n]
      const isActive = !state.inTour && n === step
      li.dataset.state = isActive ? 'active' : choice || ''
      const btn = li.querySelector('button')
      btn.setAttribute('aria-current', isActive ? 'step' : 'false')
    })

    footDots.innerHTML = STEPS.map((n) => {
      const cls = n === step ? 'on' : state.choices[n] === 'skipped' ? 'skipped' : ''
      return `<i class="${cls}"></i>`
    }).join('')

    stepCount.textContent = `Step ${step} of 7`
    if (state.inTour) stepCount.textContent = `Step 5 of 7 · tour stop ${state.stop + 1}/${TOUR.length}`
    renderDone()
    syncAnalysisStep()
  }

  function renderDone() {
    const skipped = STEPS.filter((n) => state.choices[n] === 'skipped')
    const card = $('#skippedCard')
    const list = $('#skippedList')
    if (!skipped.length) {
      card.hidden = true
      $('#doneLead').textContent = 'Nothing here was required, and nothing was skipped. The harness is ready as configured.'
      return
    }
    card.hidden = false
    $('#skippedTitle').textContent = `You skipped ${skipped.length} step${skipped.length > 1 ? 's' : ''}: defaults apply`
    const consequences = {
      1: 'The tour never ran; nothing changes.',
      2: 'Sandbox stays at workspace-write.',
      3: 'Kilo Gateway stays the default route (keyless, free).',
      4: 'Compaction, Keeper and Whiteboard stay on (the install default), and can be switched off later in Settings → Orchestration.',
      5: 'The interface tour was skipped; reopen it from this demo or the Help surface later.',
      6: "Agents start from a default system context; ask Sysadmin to analyse the machine later.",
      7: 'Nothing to skip at the end.',
    }
    list.innerHTML = skipped.map((n) => `<li><strong>Step ${n} · ${STEP_META[n].label}:</strong> ${consequences[n]}</li>`).join('')
    $('#doneLead').textContent = 'Skipped steps keep their defaults. The harness works either way. Nothing below is required.'
  }

  function markCurrent(choice) {
    if (state.step >= 1 && state.step <= 7) {
      const prev = state.choices[state.step]
      // A configured step is never downgraded to accepted-defaults or skipped.
      if (prev === 'done') return
      state.choices[state.step] = choice
    }
  }

  // Leaving a step with Continue: accepted-defaults, unless an action in the
  // step already marked it configured.
  function acceptCurrent() {
    if (state.step >= 1 && state.step <= 7 && !state.choices[state.step]) {
      state.choices[state.step] = 'default'
    }
  }

  function gotoStep(n, opts = {}) {
    const target = Math.min(7, Math.max(1, n))
    if (state.inTour) exitTour('skipped', true)
    const forward = target > state.step
    if (forward) {
      // Steps passed over keep their defaults — only an explicit Skip click
      // marks a step skipped.
      for (let n = state.step; n < target; n += 1) {
        if (!state.choices[n]) state.choices[n] = 'default'
      }
    }
    state.step = target
    render()
    if (!opts.keepHash) syncHash()
    if (!opts.instant) {
      panelScroll.scrollTop = 0
      const heading = document.querySelector(`.step[data-step="${target}"] h1`)
      if (heading) heading.focus({ preventScroll: true })
    }
  }

  function next() {
    if (state.inTour) { tourNext(); return }
    if (state.step === 7) { finish(); return }
    acceptCurrent()
    gotoStep(state.step + 1)
  }

  function prev() {
    if (state.inTour) { tourPrev(); return }
    gotoStep(state.step - 1)
  }

  function skipStep() {
    if (state.inTour) { exitTour('skipped'); return }
    if (state.step === 7) { finish(); return }
    markCurrent('skipped')
    gotoStep(state.step + 1)
  }

  function skipAll() {
    if (state.inTour) exitTour('skipped', true)
    // The explicit "Skip the tour": the remaining steps are skipped, not defaulted.
    for (let n = 2; n <= 6; n += 1) {
      if (!state.choices[n]) state.choices[n] = 'skipped'
    }
    if (!state.choices[1]) state.choices[1] = 'done'
    gotoStep(7, { keepHash: true })
    syncHash()
  }

  function finish() {
    markCurrent('done')
    state.finished = true
    body.dataset.mode = 'done'
    doneToast.hidden = false
    syncHash()
  }

  function reset() {
    clearTimers()
    state.step = 1
    state.stop = 0
    state.inTour = false
    state.analysis = 'idle'
    state.sandbox = 'workspace-write'
    state.toggles = { compaction: true, keeper: true, whiteboard: true }
    state.compactionMode = 'llm'
    state.choices = {}
    state.finished = false
    body.dataset.mode = ''
    doneToast.hidden = true
    helpMask.hidden = true
    spot.hidden = true
    dock.hidden = true
    dockLines.innerHTML = ''
    dockFoot.hidden = true
    dockTag.hidden = false
    offerStatus.hidden = true
    offerActions.hidden = false
    resetProvider()
    $$('.switch').forEach((sw) => setSwitch(sw, true))
    $$('.radio').forEach((r) => {
      const on = r.dataset.mode === 'workspace-write'
      r.setAttribute('aria-checked', String(on))
      if (on) state.sandbox = r.dataset.mode
    })
    setCompactionMode('llm')
    updateIntelButton()
    render()
    syncHash()
    toast('Demo reset. Nothing was ever stored.')
  }

  // ── Step 3: the Add Provider mirror (catalogue → form → discovery) ────────

  // The picker grid in the real render order: Popular, then every mainstream
  // preset — AddProviderModal repeats the popular rows inside All Providers —
  // then the heavy rows. Names are set as text, never markup.
  function pickerCard(id, name, kind) {
    const el = document.createElement('div')
    el.className = kind === 'kilo' ? 'pcard preselected' : 'pcard'
    el.setAttribute('role', 'button')
    el.setAttribute('tabindex', '-1')
    if (kind === 'heavy') el.dataset.heavy = id
    else el.dataset.provider = id
    const ico = document.createElement('span')
    ico.className = 'pico'
    ico.setAttribute('aria-hidden', 'true')
    ico.textContent = ''
    const info = document.createElement('span')
    info.className = 'pinfo'
    const pname = document.createElement('span')
    pname.className = 'pname'
    pname.textContent = name
    const pid = document.createElement('span')
    pid.className = 'pid'
    pid.textContent = id
    info.append(pname, pid)
    if (kind === 'heavy') {
      const badge = document.createElement('span')
      badge.className = 'pbadge'
      badge.textContent = 'Listed, add to configure'
      info.appendChild(badge)
    }
    el.append(ico, info)
    if (kind === 'kilo') {
      const flag = document.createElement('span')
      flag.className = 'pflag'
      flag.textContent = 'Free · default'
      const check = document.createElement('span')
      check.className = 'pcheck'
      check.setAttribute('aria-hidden', 'true')
      check.textContent = '✓'
      el.append(flag, check)
    }
    return el
  }

  function renderCatalogue() {
    const grid = $('#pGrid')
    const group = (label) => {
      const el = document.createElement('div')
      el.className = 'pgroup'
      el.textContent = label
      return el
    }
    grid.appendChild(group('Popular'))
    POPULAR_PROVIDERS.forEach((id) => {
      const p = PROVIDERS[id]
      if (p) grid.appendChild(pickerCard(p.id, p.name))
    })
    grid.appendChild(group('All Providers'))
    CATALOGUE.forEach((p) => {
      grid.appendChild(pickerCard(p.id, p.name, p.id === 'kilo' ? 'kilo' : undefined))
    })
    grid.appendChild(group('Self-hosted / heavy'))
    HEAVY_ROWS.forEach(({ id, name }) => grid.appendChild(pickerCard(id, name, 'heavy')))
  }

  function showProviderView(view) {
    state.providerView = view
    $$('#pModal .pview').forEach((el) => { el.hidden = el.dataset.pview !== view })
    $('#pFootPicker').hidden = view !== 'picker'
    $('#pFootForm').hidden = view !== 'form'
    $('#pFootHeavy').hidden = view !== 'heavy'
    $('#pFootDocs').hidden = view !== 'heavydocs'
    const heavyish = view === 'heavy' || view === 'heavydocs'
    $('#pModalTitle').textContent = view === 'picker'
      ? 'Add model provider'
      : `Add ${heavyish ? 'FreeLLMAPI' : (PROVIDERS[state.provider] || PROVIDERS.kilo).name}`
    $('#pFootNote').textContent = view === 'picker'
      ? 'Kilo Gateway is installed and running by default: free and keyless.'
      : view === 'form'
        ? (PROVIDERS[state.provider] && PROVIDERS[state.provider].keyless
          ? 'Keyless route: nothing here needs a key.'
          : 'Template preset: fields are filled from the shipped provider list.')
        : view === 'heavy'
          ? 'Detected instance: nothing is installed until you choose Install locally.'
          : 'Platform install steps: the host platform is selected by default.'
    $('#pModalBody').scrollTop = 0
  }

  function openProviderModal(view) {
    state.providerOpen = true
    showProviderView(view || (state.providerCreated ? 'form' : 'picker'))
    $('#pOverlay').hidden = false
  }

  function closeProviderModal() {
    state.providerOpen = false
    $('#pOverlay').hidden = true
  }

  function updateProviderSummary(created) {
    if (!created) {
      $('#psTitle').textContent = 'Kilo Gateway: installed by default'
      $('#psSub').textContent = 'Free · no key needed, already running as the default route.'
      $('#psRoute').textContent = 'kilo · openai-completions · https://api.kilo.ai/api/gateway · free tier, no key'
      $('#psRoute').hidden = false
      return
    }
    $('#psTitle').textContent = `${created.name}: configured`
    $('#psSub').textContent = created.sub
    $('#psRoute').textContent = created.route
    $('#psRoute').hidden = false
  }

  function resetProviderResult() {
    $('#pResult').hidden = true
    $('#pDiscovering').hidden = true
    $('#pDiscovered').hidden = true
    $('#pTestOk').hidden = true
    $('#pTestBubble').hidden = true
    const btn = $('#btnPCreate')
    btn.disabled = false
    btn.textContent = 'Create provider'
  }

  function selectProvider(id) {
    const p = PROVIDERS[id]
    if (!p) return
    state.provider = id
    $('#pDisplayName').value = p.name
    $('#pProviderId').value = id
    $('#pProtocol').value = p.protocol
    $('#pBaseUrl').value = p.baseURL
    $('#pApiKey').value = ''
    $('#pApiKey').placeholder = p.keyless
      ? 'No key required (leave empty for the anonymous free tier)'
      : p.env && p.env.length ? `Env ref: ${p.env[0]}` : 'Enter API Key (optional for local/proxy endpoints)'
    $('#pEnv').textContent = p.env && p.env.length ? p.env.join(', ') : 'none'
    $('#pKeylessHint').hidden = !p.keyless
    $('#pDoc').hidden = !p.doc
    if (p.doc) $('#pDoc').href = p.doc
    resetProviderResult()
    showProviderView('form')
  }

  function finishProviderCreate(p) {
    state.providerCreated = true
    $('#pDiscovering').hidden = true
    $('#pResult').hidden = false
    $('#pDiscovered').innerHTML = p.models
      ? `✓ Models discovered: <strong>${p.models}</strong>, written to the route.`
      : '✓ Models discovered, written to the route.'
    $('#pDiscovered').hidden = false
    if (p.keyless) {
      $('#pTestOk').hidden = false
      $('#pTestBubble').hidden = false
    }
    const btn = $('#btnPCreate')
    btn.disabled = false
    btn.textContent = 'Done'
    updateProviderSummary({
      name: p.name,
      sub: p.keyless
        ? 'Keyless free route: discovery and the test call succeeded.'
        : 'Route created: discovery and the test call succeeded.',
      route: `${state.provider} · ${p.protocol} · ${p.baseURL || 'default endpoint'}`,
    })
    markCurrent('done')
    render()
  }

  function createProvider() {
    if (state.providerCreated) { closeProviderModal(); return }
    const p = PROVIDERS[state.provider]
    if (!p || state.providerRunning) return
    state.providerRunning = true
    $('#pResult').hidden = false
    $('#pDiscovering').hidden = false
    $('#pDiscovered').hidden = true
    $('#pTestOk').hidden = true
    $('#pTestBubble').hidden = true
    const btn = $('#btnPCreate')
    btn.disabled = true
    btn.textContent = 'Discovering models…'
    later(() => {
      state.providerRunning = false
      finishProviderCreate(p)
      toast('Demo only: no route was created. Discovery and the test call are simulated.')
    }, 1150)
  }

  function setProviderPlatform(plat) {
    const data = FREELLMAPI_PLATFORMS[plat]
    if (!data) return
    $$('.ph-plat').forEach((b) => b.classList.toggle('on', b.dataset.plat === plat))
    $('#phLocalLabel').textContent = data.label
    $('#phLocalDeps').textContent = `Dependencies: ${data.deps}`
    $('#phLocalDisk').textContent = `Footprint: ${data.disk}`
    $('#phSteps').innerHTML = data.steps.map((s) =>
      `<li><strong>${s.label}</strong><pre>${s.command.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre></li>`).join('')
    $('#phInstallList').innerHTML = data.steps.map((s) => `<li>${s.label}</li>`).join('')
  }

  function resetProvider() {
    state.provider = 'kilo'
    state.providerCreated = false
    state.providerRunning = false
    state.providerOpen = false
    closeProviderModal()
    resetProviderResult()
    setProviderPlatform('linux')
    showProviderView('picker')
    updateProviderSummary(null)
  }

  function applyProviderHash(h) {
    if (!h || h.step !== 3) return
    if (h.view === 'heavy') { openProviderModal('heavy'); return }
    if (h.view === 'docs') { openProviderModal('heavydocs'); return }
    if (h.view === 'picker') { openProviderModal('picker'); return }
    if (h.run) {
      selectProvider('kilo')
      finishProviderCreate(PROVIDERS.kilo)
      openProviderModal('form')
      return
    }
    if (h.provider && PROVIDERS[h.provider]) { selectProvider(h.provider); openProviderModal('form'); return }
    closeProviderModal()
  }

  // ── Step 4: toggles ───────────────────────────────────────────────────────

  function setSwitch(sw, on) {
    sw.setAttribute('aria-checked', String(on))
    sw.querySelector('.sw-label').textContent = on ? 'On' : 'Off'
    const card = sw.closest('.toggle-card')
    card.dataset.on = String(on)
    card.querySelector('.toggle-detail').hidden = !on
    const feature = card.dataset.feature
    state.toggles[feature] = on
    if (feature === 'compaction') setCompactionMode(state.compactionMode)
    updateIntelButton()
  }

  function updateIntelButton() {
    const any = Object.values(state.toggles).some(Boolean)
    $('#btnIntelNext').innerHTML = any
      ? 'Continue <span class="arrow">→</span>'
      : 'Continue with them off <span class="arrow">→</span>'
  }

  function setCompactionMode(mode) {
    state.compactionMode = mode
    $$('.seg-btn').forEach((b) => {
      const on = b.dataset.comp === mode
      b.classList.toggle('on', on)
      b.setAttribute('aria-checked', String(on))
    })
    const llmChip = $('[data-llm-chip]')
    const mechChip = $('[data-mech-chip]')
    if (llmChip && mechChip) {
      llmChip.hidden = mode !== 'llm'
      mechChip.hidden = mode !== 'mechanical'
    }
  }

  // ── Step 5: spotlight tour ────────────────────────────────────────────────

  function startTour(stopIndex = 0) {
    state.inTour = true
    state.stop = Math.max(0, Math.min(TOUR.length - 1, stopIndex))
    body.dataset.mode = 'tour'
    spot.hidden = false
    renderTip()
    positionSpot(true)
    render()
    spotTip.querySelector('h2').focus({ preventScroll: true })
    syncHash()
  }

  function exitTour(choice, silent) {
    if (!state.inTour) return
    state.inTour = false
    spot.hidden = true
    body.dataset.mode = ''
    if (choice && !silent) markCurrent(choice)
    render()
    syncHash()
  }

  function tourNext() {
    if (state.stop < TOUR.length - 1) {
      state.stop += 1
      renderTip()
      positionSpot(false)
      render()
      syncHash()
    } else {
      markCurrent('done')
      exitTour(null)
      gotoStep(6, { keepHash: true })
      toast('Tour complete. The panel picks up at step 6.')
      syncHash()
    }
  }

  function tourPrev() {
    if (state.stop > 0) {
      state.stop -= 1
      renderTip()
      positionSpot(false)
      render()
      syncHash()
    }
  }

  function renderTip() {
    const stop = TOUR[state.stop]
    tipCount.textContent = `Stop ${state.stop + 1} of ${TOUR.length}`
    tipTitle.textContent = stop.title
    tipBody.textContent = stop.body
    $('#tipNext').textContent = state.stop === TOUR.length - 1 ? 'Finish the tour' : 'Next stop →'
    $('#tipBack').disabled = state.stop === 0
  }

  function positionSpot(instant) {
    const stop = TOUR[state.stop]
    const el = document.querySelector(stop.target)
    if (!el) return
    const pad = stop.pad || 8
    const r = el.getBoundingClientRect()
    const hole = {
      left: r.left - pad,
      top: r.top - pad,
      width: r.width + pad * 2,
      height: r.height + pad * 2,
    }
    if (instant) spotHole.classList.add('no-anim')
    spotHole.style.left = `${hole.left}px`
    spotHole.style.top = `${hole.top}px`
    spotHole.style.width = `${hole.width}px`
    spotHole.style.height = `${hole.height}px`
    if (instant) requestAnimationFrame(() => spotHole.classList.remove('no-anim'))

    // Tip: measure after content is current.
    const tipW = spotTip.offsetWidth || 330
    const tipH = spotTip.offsetHeight || 180
    const m = 14
    let left
    let top
    if (stop.place === 'right') {
      left = hole.left + hole.width + m
      top = hole.top + hole.height / 2 - tipH / 2
    } else if (stop.place === 'left') {
      left = hole.left - tipW - m
      top = hole.top + hole.height / 2 - tipH / 2
    } else if (stop.place === 'top') {
      left = hole.left + hole.width / 2 - tipW / 2
      top = hole.top - tipH - m
    } else {
      left = hole.left + hole.width / 2 - tipW / 2
      top = hole.top + hole.height + m
    }
    left = Math.max(16, Math.min(left, innerWidth - tipW - 16))
    top = Math.max(64, Math.min(top, innerHeight - tipH - 16))
    spotTip.style.left = `${left}px`
    spotTip.style.top = `${top}px`
  }

  // ── Step 6: background analysis ───────────────────────────────────────────

  const ANALYSIS_STEPS = [
    'Reading hardware: CPU, memory, GPU…',
    'OS and kernel…',
    'Services and listening ports…',
    'Writing the system context…',
  ]

  // Re-entry is never terminal: a skip only defers the offer, so returning to
  // step 6 always restores both decisions. While the run is under way or
  // already finished the card's buttons stay hidden and the footer's
  // `Skip step` carries the step forward.
  function syncAnalysisStep() {
    if (state.analysis === 'running') {
      offerActions.hidden = true
      offerStatus.hidden = false
      offerStatus.textContent = 'Running in the background. Keep going, you do not need to wait.'
      return
    }
    if (state.analysis === 'done') {
      offerActions.hidden = true
      offerStatus.hidden = false
      offerStatus.textContent = '✓ System context ready. Agents can now see this machine (sample data in this demo).'
      return
    }
    offerActions.hidden = false
    const skipped = state.choices[6] === 'skipped'
    offerStatus.hidden = !skipped
    offerStatus.textContent = skipped
      ? 'Skipped earlier. You can still run the analysis, or skip it again.'
      : ''
  }

  function startAnalysis(navigate) {
    if (state.analysis !== 'idle') return
    state.analysis = 'running'
    markCurrent('done')
    render()
    dock.hidden = false
    dockTitle.textContent = 'System analysis · running'
    dockFoot.hidden = true
    dockTag.hidden = false
    offerActions.hidden = true
    offerStatus.hidden = false
    offerStatus.textContent = 'Running in the background. Keep going, you do not need to wait.'
    // From the step's primary action the wizard moves on immediately; the
    // `#step=6&run=1` deep link starts the same run without leaving the step.
    if (navigate) gotoStep(7)

    ANALYSIS_STEPS.forEach((text, i) => {
      later(() => {
        const li = document.createElement('li')
        li.innerHTML = i === ANALYSIS_STEPS.length - 1
          ? `<span class="busy">◐</span>${text}`
          : `<span class="tick">✓</span>${text}`
        dockLines.appendChild(li)
        if (i > 0) {
          const prevLi = dockLines.children[i - 1]
          if (prevLi) prevLi.innerHTML = `<span class="tick">✓</span>${ANALYSIS_STEPS[i - 1]}`
        }
        if (i === ANALYSIS_STEPS.length - 1) {
          later(() => {
            state.analysis = 'done'
            dockTitle.textContent = 'System analysis · ready'
            dockTag.hidden = true
            dockFoot.hidden = false
            dockLines.children[i].innerHTML = `<span class="tick">✓</span>${text}`
            if (state.step === 6) {
              offerStatus.textContent = '✓ System context ready. Agents can now see this machine (sample data in this demo).'
            } else {
              toast('System analysis finished in the background. Context is ready.')
            }
            render()
          }, 900)
        }
      }, 650 + i * 700)
    })
  }

  function skipAnalysis() {
    // Skipping defers the offer, it does not retire it: `choices[6]` keeps the
    // skip accounting while syncAnalysisStep restores the card on re-entry.
    markCurrent('skipped')
    gotoStep(7)
  }

  // ── Keyboard + hash ───────────────────────────────────────────────────────

  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    if (state.providerOpen && e.key !== 'Escape') return
    const t = e.target
    if (t && t.closest && t.closest('input, textarea, select')) return
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault()
        next()
        break
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault()
        prev()
        break
      case 'Escape':
        if (!helpMask.hidden) { helpMask.hidden = true; break }
        if (state.providerOpen) { closeProviderModal(); break }
        e.preventDefault()
        skipStep()
        break
      case 'r':
      case 'R':
        reset()
        break
      case '?':
        helpMask.hidden = !helpMask.hidden
        break
      default:
        if (/^[1-7]$/.test(e.key)) {
          if (state.inTour) exitTour('skipped', true)
          gotoStep(Number(e.key))
        }
    }
  }

  function syncHash() {
    if (state.inTour) {
      writeHash(`step=5&stop=${state.stop}`)
    } else {
      writeHash(`step=${state.step}`)
    }
  }

  function writeHash(fragment) {
    try {
      history.replaceState(null, '', `#${fragment}`)
    } catch {
      /* file:// in some browsers refuses replaceState; deep links still work on load. */
    }
  }

  function applyHash() {
    const raw = location.hash.replace(/^#/, '')
    if (!raw) return null
    const params = new URLSearchParams(raw)
    const out = {}
    if (params.has('step')) out.step = Number(params.get('step'))
    if (params.has('stop')) out.stop = Number(params.get('stop'))
    if (params.get('run') === '1') out.run = true
    if (params.has('enable')) out.enable = params.get('enable')
    if (params.has('off')) out.off = params.get('off')
    if (params.has('view')) out.view = params.get('view')
    if (params.has('provider')) out.provider = params.get('provider')
    return out
  }

  // ── Wiring ────────────────────────────────────────────────────────────────

  function bind() {
    $$('[data-next]').forEach((b) => b.addEventListener('click', next))
    $$('[data-back]').forEach((b) => b.addEventListener('click', prev))
    $$('[data-skip-step]').forEach((b) => b.addEventListener('click', skipStep))
    $$('[data-skip-all]').forEach((b) => b.addEventListener('click', skipAll))
    $$('#stepList [data-jump]').forEach((li, i) => {
      li.querySelector('button').addEventListener('click', () => gotoStep(i + 1))
    })
    $('#btnResetTop').addEventListener('click', reset)
    $('#btnDoneReset').addEventListener('click', reset)
    $('#btnHelp').addEventListener('click', () => { helpMask.hidden = !helpMask.hidden })
    $('#btnHelpClose').addEventListener('click', () => { helpMask.hidden = true })
    helpMask.addEventListener('click', (e) => { if (e.target === helpMask) helpMask.hidden = true })

    $('#pGrid').addEventListener('click', (e) => {
      const card = e.target.closest('.pcard')
      if (!card) return
      if (card.dataset.provider) { selectProvider(card.dataset.provider); return }
      if (card.dataset.heavy === 'freellmapi') { showProviderView('heavy'); return }
      toast('Demo mirror: FreeLLMAPI is the worked example; in the wired wizard every heavy row opens this same form.')
    })
    $('#btnAddProvider').addEventListener('click', () => openProviderModal())
    $('#btnPClose').addEventListener('click', closeProviderModal)
    $('#btnPCancel').addEventListener('click', closeProviderModal)
    $('#btnPEmpty').addEventListener('click', () => {
      toast('Demo mirror: every row here is a template; the real screen also accepts an empty route.')
    })
    $('#pOverlay').addEventListener('click', (e) => {
      if (e.target === $('#pOverlay')) closeProviderModal()
    })
    $('#btnPBack').addEventListener('click', () => showProviderView('picker'))
    $('#btnPHeavyBack').addEventListener('click', () => showProviderView('picker'))
    $('#btnPDocsBack').addEventListener('click', () => showProviderView('heavy'))
    $('#btnPCreate').addEventListener('click', createProvider)
    $('#btnPHeavyCreate').addEventListener('click', () => {
      state.providerCreated = true
      updateProviderSummary({
        name: 'FreeLLMAPI',
        sub: 'Detected instance at http://127.0.0.1:3002. Nothing new was installed on this machine.',
        route: 'freellmapi · use detected instance · http://127.0.0.1:3002/v1',
      })
      markCurrent('done')
      closeProviderModal()
      render()
      toast('Demo only: nothing was installed. In the real wizard this detects the instance or runs the install job.')
    })
    $('#btnPhDocs').addEventListener('click', () => showProviderView('heavydocs'))
    $('#phCheck').addEventListener('click', () => {
      const badge = $('#phHealth')
      badge.textContent = 'Checking…'
      later(() => { badge.textContent = 'Healthy · 200' }, 700)
    })
    $$('.ph-plat').forEach((b) => b.addEventListener('click', () => setProviderPlatform(b.dataset.plat)))

    $$('.radio').forEach((r) => r.addEventListener('click', () => {
      state.sandbox = r.dataset.mode
      $$('.radio').forEach((o) => o.setAttribute('aria-checked', String(o === r)))
      markCurrent('done')
      render()
    }))

    $$('.switch').forEach((sw) => sw.addEventListener('click', () => {
      setSwitch(sw, sw.getAttribute('aria-checked') !== 'true')
      markCurrent('done')
      render()
    }))
    $$('.seg-btn').forEach((b) => b.addEventListener('click', () => setCompactionMode(b.dataset.comp)))

    $('#btnAnalyse').addEventListener('click', () => startAnalysis(true))
    $('#btnSkipAnalyse').addEventListener('click', skipAnalysis)

    $('#tipNext').addEventListener('click', tourNext)
    $('#tipBack').addEventListener('click', tourPrev)
    $('#tipSkip').addEventListener('click', () => { markCurrent('skipped'); exitTour(null); gotoStep(6, { keepHash: true }) })

    const startBtn = document.querySelector('[data-start-tour]')
    if (startBtn) startBtn.addEventListener('click', () => startTour(0))

    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', () => { if (state.inTour) positionSpot(true) })
    window.addEventListener('hashchange', () => {
      // Deep-link updates from outside (or an address-bar edit).
      const h = applyHash()
      if (!h) return
      if (h.step && h.step !== state.step) gotoStep(h.step, { instant: true })
      if (h.step === 5 && h.stop !== undefined && !state.inTour) startTour(h.stop)
      if (h.step === 3) applyProviderHash(h)
      applyToggleHash(h)
    })
  }

  function boot() {
    // Authored inside step 3, but the glass panel's backdrop-filter would
    // otherwise become the containing block for the fixed overlay and clip it.
    document.body.appendChild($('#pOverlay'))
    renderCatalogue()
    bind()
    const h = applyHash()
    state.step = h && h.step >= 1 && h.step <= 7 ? h.step : 1
    render()
    if (h && h.step === 5 && h.stop !== undefined) startTour(h.stop)
    if (h && h.step === 6 && h.run) startAnalysis()
    applyToggleHash(h)
    applyProviderHash(h)
  }

  function applyToggleHash(h) {
    if (!h) return
    if (h.enable) {
      h.enable.split(',').forEach((feature) => {
        const sw = document.querySelector(`.toggle-card[data-feature="${feature}"] .switch`)
        if (sw) setSwitch(sw, true)
      })
    }
    if (h.off) {
      h.off.split(',').forEach((feature) => {
        const sw = document.querySelector(`.toggle-card[data-feature="${feature}"] .switch`)
        if (sw) setSwitch(sw, false)
      })
    }
    updateIntelButton()
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot)
  else boot()
})()
