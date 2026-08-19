import { Button, H, Input, Text, TextArea } from '@/primitives'
import { useEffect, useMemo, useState } from 'react'
import { cva } from '@/styled-system/css'
import { useTranslation } from 'react-i18next'
import { styled, VStack } from '@/styled-system/jsx'
import { usePostHog } from 'posthog-js/react'
import type { PostHog } from 'posthog-js'
import { Button as RACButton } from 'react-aria-components'
import { useIsAnalyticsEnabled } from '@/features/analytics/hooks/useIsAnalyticsEnabled'
import { CandidateInfo } from '@/stores/connectionObserver'

const Card = styled('div', {
  base: {
    border: '1px solid',
    borderColor: 'gray.300',
    padding: '1rem',
    marginTop: '1.5rem',
    borderRadius: '0.25rem',
    boxShadow: '',
    minWidth: '380px',
    minHeight: '196px',
  },
})

const Bar = styled('div', {
  base: {
    display: 'flex',
    border: '2px solid',
    borderColor: 'gray.300',
    borderRadius: '8px',
    overflowY: 'hidden',
    scrollbar: 'hidden',
  },
})

const ratingButtonRecipe = cva({
  base: {
    backgroundColor: 'greyscale.000',
    color: 'initial',
    border: 'none',
    borderRadius: 0,
    padding: '0.5rem 0.85rem',
    flexGrow: '1',
    cursor: 'pointer',
  },
  variants: {
    selected: {
      true: {
        backgroundColor: 'primary.800',
        color: 'white',
      },
      false: {
        '&[data-hovered]': {
          backgroundColor: 'gray.100',
        },
      },
    },
    borderLeft: {
      true: {
        borderLeft: '1px solid',
        borderColor: 'gray.300',
      },
    },
  },
})

const labelRecipe = cva({
  base: {
    color: 'gray.600',
    paddingTop: '0.25rem',
  },
})

const OpenFeedback = ({
  posthog,
  onNext,
  metadata,
}: {
  posthog: PostHog
  onNext: () => void
  metadata?: Record<string, unknown>
}) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'openFeedback' })
  const [feedback, setFeedback] = useState('')

  const onContinue = () => {
    setFeedback('')
    onNext()
  }

  const onSubmit = () => {
    try {
      posthog.capture('open-feedback', {
        feedback,
        ...metadata,
      })
    } catch (e) {
      console.warn(e)
    } finally {
      onContinue()
    }
  }

  return (
    <Card>
      <H lvl={3}>{t('question')}</H>
      {/* eslint-disable jsx-a11y/no-autofocus -- 这一屏整体只为写这段反馈,而它是用户
          推进向导后**新挂载**的一步(挂载即揭示),焦点该直接进来。判据同
          TextPromptDialog:打开后第一件事不含歧义地就是打字。 */}
      <TextArea
        autoFocus
        id="feedbackInput"
        name="feedback"
        placeholder={t('placeholder')}
        required
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        style={{
          minHeight: '150px',
          marginBottom: '1rem',
        }}
      />
      {/* eslint-enable jsx-a11y/no-autofocus */}
      <VStack gap="0.5">
        <Button
          variant="primary"
          size="sm"
          fullWidth
          isDisabled={!feedback}
          onPress={onSubmit}
        >
          {t('submit')}
        </Button>
        <Button
          invisible
          variant="secondary"
          size="sm"
          fullWidth
          onPress={onNext}
        >
          {t('skip')}
        </Button>
      </VStack>
    </Card>
  )
}

const RateQuality = ({
  posthog,
  onNext,
  metadata,
  maxRating = 5,
}: {
  posthog: PostHog
  onNext: () => void
  metadata?: Record<string, unknown>
  maxRating?: number
}) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'rating' })
  const [selectedRating, setSelectedRating] = useState<number | null>(null)

  const handleRatingClick = (rating: number) => {
    setSelectedRating((prevRating) => (prevRating === rating ? null : rating))
  }

  const onSubmit = () => {
    try {
      posthog.capture('quality-rating', {
        rating: selectedRating,
        ...metadata,
      })
    } catch (e) {
      console.warn(e)
    } finally {
      setSelectedRating(null)
      onNext()
    }
  }

  return (
    <Card>
      <H lvl={3}>{t('question')}</H>
      <Bar>
        {[...Array(maxRating)].map((_, index) => (
          <RACButton
            key={index}
            onPress={() => handleRatingClick(index + 1)}
            className={ratingButtonRecipe({
              selected: selectedRating === index + 1,
              borderLeft: index != 0,
            })}
          >
            {index + 1}
          </RACButton>
        ))}
      </Bar>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: '1rem',
        }}
      >
        <Text variant="sm" className={labelRecipe()}>
          {t('levels.min')}
        </Text>
        <Text variant="sm" className={labelRecipe()}>
          {t('levels.max')}
        </Text>
      </div>
      <Button
        variant="primary"
        size="sm"
        fullWidth
        isDisabled={!selectedRating}
        onPress={onSubmit}
      >
        {t('submit')}
      </Button>
    </Card>
  )
}

const ConfirmationMessage = ({ onNext }: { onNext: () => void }) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'confirmationMessage' })
  useEffect(() => {
    const timer = setTimeout(() => {
      onNext()
    }, 10000)
    return () => clearTimeout(timer)
  }, [onNext])
  return (
    <Card
      style={{
        maxWidth: '380px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      <VStack gap={0}>
        <H lvl={3}>{t('heading')}</H>
        <Text as="p" variant="paragraph" centered>
          {t('body')}
        </Text>
      </VStack>
    </Card>
  )
}

const AuthenticationMessage = ({
  onNext,
  posthog,
}: {
  onNext: () => void
  posthog: PostHog
}) => {
  const { t } = useTranslation('rooms', { keyPrefix: 'authenticationMessage' })

  const [email, setEmail] = useState('')

  const onSubmit = () => {
    posthog.people.set({ unsafe_email: email })
    onNext()
  }

  return (
    <Card
      style={{
        maxWidth: '380px',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
      }}
    >
      <H lvl={3}>{t('heading')}</H>
      {/* eslint-disable jsx-a11y/no-autofocus -- 同上:这一步只为填邮箱,且是推进向导
          后新挂载的一屏。 */}
      <Input
        autoFocus
        id="emailInput"
        name="email"
        placeholder={t('placeholder')}
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        style={{
          marginBottom: '1rem',
        }}
      />
      {/* eslint-enable jsx-a11y/no-autofocus */}
      <VStack gap="0.5">
        <Button
          variant="primary"
          size="sm"
          fullWidth
          isDisabled={!email}
          onPress={onSubmit}
        >
          {t('submit')}
        </Button>
        <Button
          invisible
          variant="secondary"
          size="sm"
          fullWidth
          onPress={onNext}
        >
          {t('ignore')}
        </Button>
      </VStack>
    </Card>
  )
}

type RatingMetadata = {
  room_id?: string
  pc_publisher?: CandidateInfo
  pc_subscriber?: CandidateInfo
  pc_publisher_changes_count?: number
  pc_subscriber_changes_count?: number
}

export const Rating = ({
  metadata: metadataProp,
}: {
  metadata: RatingMetadata
}) => {
  const isAnalyticsEnabled = useIsAnalyticsEnabled()
  const posthog = usePostHog()

  const isUserAnonymous = useMemo(() => {
    return posthog.get_property('$user_state') == 'anonymous'
  }, [posthog])

  const [step, setStep] = useState(0)

  const sessionId = useMemo(() => crypto.randomUUID(), [])

  const metadata = useMemo(
    () => ({
      session_id: sessionId,
      ...metadataProp,
    }),
    [sessionId, metadataProp]
  )

  if (!isAnalyticsEnabled) return

  if (step == 0) {
    return (
      <RateQuality
        posthog={posthog}
        onNext={() => setStep(step + 1)}
        metadata={metadata}
      />
    )
  }

  if (step == 1) {
    return (
      <OpenFeedback
        posthog={posthog}
        onNext={() => setStep(step + 1)}
        metadata={metadata}
      />
    )
  }

  if (step == 2) {
    return isUserAnonymous ? (
      <AuthenticationMessage
        posthog={posthog}
        onNext={() => setStep(step + 1)}
      />
    ) : (
      <ConfirmationMessage onNext={() => setStep(0)} />
    )
  }

  if (step == 3) {
    return <ConfirmationMessage onNext={() => setStep(0)} />
  }
}
