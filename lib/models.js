export async function buildModelCatalog(llm) {
  const catalog = await Promise.all(llm.listProviders().map(async provider => {
    try {
      const advertised = await llm.listModels(provider.id)
      const models = await Promise.all(advertised.map(async model => {
        const resolved = await llm.resolveModelInfo(provider.id, model.id)
        return {
          id: model.id,
          name: model.name,
          ...(model.description === undefined ? {} : { description: model.description }),
          ...(resolved.reasoning === undefined ? {} : {
            reasoning: {
              efforts: resolved.reasoning.efforts.map(effort => ({
                id: effort.id,
                name: effort.name,
                ...(effort.description === undefined ? {} : { description: effort.description }),
              })),
              ...(resolved.reasoning.defaultEffort === undefined
                ? {}
                : { defaultEffort: resolved.reasoning.defaultEffort }),
            },
          }),
        }
      }))
      return {
        kind: 'group',
        value: { id: provider.id, name: provider.name, models },
      }
    } catch (error) {
      return {
        kind: 'failure',
        value: {
          id: provider.id,
          name: provider.name,
          message: error instanceof Error ? error.message : String(error),
        },
      }
    }
  }))
  return {
    groups: catalog.filter(item => item.kind === 'group' && item.value.models.length > 0).map(item => item.value),
    failures: catalog.filter(item => item.kind === 'failure').map(item => item.value),
  }
}

export async function resolveModelSelection(llm, requested) {
  const resolved = await llm.resolveCallConfig({
    provider: requested.provider,
    model: requested.model,
    ...(requested.reasoningEffort === undefined ? {} : { reasoningEffort: requested.reasoningEffort }),
  })
  return {
    provider: resolved.provider,
    model: resolved.model,
    ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
  }
}

export function parseModelCommand(argument) {
  const tokens = argument.trim().split(/\s+/u).filter(Boolean)
  if (tokens.length === 0) return undefined
  if (tokens.length > 2) throw new Error('用法：/model <提供方>/<模型> [推理强度]')
  const separator = tokens[0].indexOf('/')
  if (separator <= 0 || separator === tokens[0].length - 1) {
    throw new Error('用法：/model <提供方>/<模型> [推理强度]')
  }
  return {
    provider: tokens[0].slice(0, separator),
    model: tokens[0].slice(separator + 1),
    ...(tokens[1] === undefined ? {} : { reasoningEffort: tokens[1] }),
  }
}

export function selectionFromSession(agent, fallback, override) {
  let picked = override
  return {
    get current() {
      if (picked !== undefined) return picked
      const logged = agent.session.requestHeader()?.config
      if (logged === undefined) return fallback()
      return {
        provider: logged.provider,
        model: logged.model,
        ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
      }
    },
    set current(next) {
      picked = next
    },
    assembled: undefined,
  }
}
