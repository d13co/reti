import { Validator } from '@/interfaces/validator'
import { formatAssetAmount } from '@/utils/format'
import { Tooltip } from './Tooltip'

export function RewardAssetCell({ validator }: { validator: Validator }) {
  if (!validator.rewardToken) return null

  const perEpochAmount = validator.rewardToken
    ? formatAssetAmount(validator.rewardToken, validator.config.rewardPerPayout, {
        unitName: true,
      })
    : null

  return (
    <Tooltip content={`${perEpochAmount} per epoch`}>
      <span className="font-mono">
        {validator.rewardToken && validator.rewardToken.params.unitName}
      </span>
    </Tooltip>
  )
}
