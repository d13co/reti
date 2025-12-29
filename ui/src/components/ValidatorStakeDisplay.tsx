import { AlgoSymbol } from '@/components/AlgoSymbol'
import { TrafficLight } from '@/components/TrafficLight'
import { Constraints } from '@/contracts/ValidatorRegistryClient'
import { useMbrAmountsAndProtocolConstraints } from '@/hooks/useMbrAmountsAndProtocolConstraints'
import { Validator } from '@/interfaces/validator'
import {
  calculateMaxStake,
  calculateSaturationPercentage,
  calculateStakeSaturation,
} from '@/utils/contracts'
import { AlgoAmount } from '@algorandfoundation/algokit-utils/types/amount'

interface ValidatorStakeDisplayProps {
  validator: Validator
}

export function ValidatorStakeDisplay({ validator }: ValidatorStakeDisplayProps) {
  const mbrAmountAndConstraints = useMbrAmountsAndProtocolConstraints()

  if (!mbrAmountAndConstraints || validator.state.numPools === 0) return '--'
  const { constraints } = mbrAmountAndConstraints

  const currentStakeAlgos = AlgoAmount.MicroAlgos(Number(validator.state.totalAlgoStaked)).algos
  const currentStakeCompact = new Intl.NumberFormat(undefined, {
    notation: 'compact',
  }).format(currentStakeAlgos)

  const maxStake = calculateMaxStake(validator, constraints)
  const maxStakeAlgos = AlgoAmount.MicroAlgos(Number(maxStake)).algos
  const maxStakeCompact = new Intl.NumberFormat(undefined, {
    notation: 'compact',
  }).format(maxStakeAlgos)

  const saturationLevel = calculateStakeSaturation(validator, constraints)
  const saturationPercent = calculateSaturationPercentage(validator, constraints)

  return (
    <span className="whitespace-nowrap">
      <AlgoSymbol />
      {currentStakeCompact} / {maxStakeCompact}
      <TrafficLight
        tooltipContent={`${saturationPercent}%`}
        indicator={saturationLevel}
        className="ml-2"
      />
    </span>
  )
}
