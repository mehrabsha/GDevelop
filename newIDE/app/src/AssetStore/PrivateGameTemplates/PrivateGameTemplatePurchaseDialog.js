// @flow
import * as React from 'react';
import { t, Trans } from '@lingui/macro';
import {
  listUserPurchases,
  type PrivateGameTemplateListingData,
} from '../../Utils/GDevelopServices/Shop';
import Dialog, { DialogPrimaryButton } from '../../UI/Dialog';
import AuthenticatedUserContext from '../../Profile/AuthenticatedUserContext';
import CreateProfile from '../../Profile/CreateProfile';
import Text from '../../UI/Text';
import { useInterval } from '../../Utils/UseInterval';
import { getStripeCheckoutUrl } from '../../Utils/GDevelopServices/Shop';
import Window from '../../Utils/Window';
import { Line, Spacer } from '../../UI/Grid';
import CircularProgress from '../../UI/CircularProgress';
import BackgroundText from '../../UI/BackgroundText';
import Mark from '../../UI/CustomSvgIcons/Mark';
import FlatButton from '../../UI/FlatButton';
import { ColumnStackLayout, LineStackLayout } from '../../UI/Layout';
import TextField from '../../UI/TextField';
import useAlertDialog from '../../UI/Alert/useAlertDialog';
import {
  shouldUseAppStoreProduct,
  purchaseAppStoreProduct,
} from '../../Utils/AppStorePurchases';
import Form from '../../UI/Form';

const PasswordPromptDialog = (props: {
  passwordValue: string,
  setPasswordValue: (newValue: string) => void,
  onClose: () => void,
  onApply: () => Promise<void>,
}) => (
  <Dialog
    open
    maxWidth="xs"
    title={<Trans>Store password</Trans>}
    onApply={props.onApply}
    onRequestClose={props.onClose}
    actions={[
      <FlatButton
        key="cancel"
        label={<Trans>Close</Trans>}
        onClick={props.onClose}
      />,
      <DialogPrimaryButton
        key="continue"
        primary
        label={<Trans>Continue</Trans>}
        onClick={props.onApply}
      />,
    ]}
  >
    <Form onSubmit={props.onApply} name="store-password">
      <TextField
        fullWidth
        autoFocus="desktopAndMobileDevices"
        value={props.passwordValue}
        floatingLabelText={<Trans>Password</Trans>}
        type="password"
        onChange={(e, value) => {
          props.setPasswordValue(value);
        }}
      />
    </Form>
  </Dialog>
);

type Props = {|
  privateGameTemplateListingData: PrivateGameTemplateListingData,
  onClose: () => void,
  simulateAppStoreProduct?: boolean,
|};

const PrivateGameTemplatePurchaseDialog = ({
  privateGameTemplateListingData,
  onClose,
  simulateAppStoreProduct,
}: Props) => {
  const {
    profile,
    getAuthorizationHeader,
    onLogin,
    onCreateAccount,
    receivedGameTemplates,
    onPurchaseSuccessful,
  } = React.useContext(AuthenticatedUserContext);
  const [isPurchasing, setIsPurchasing] = React.useState(false);
  const [
    isCheckingPurchasesAfterLogin,
    setIsCheckingPurchasesAfterLogin,
  ] = React.useState(!receivedGameTemplates);
  const [purchaseSuccessful, setPurchaseSuccessful] = React.useState(false);
  const [
    displayPasswordPrompt,
    setDisplayPasswordPrompt,
  ] = React.useState<boolean>(false);
  const [password, setPassword] = React.useState<string>('');
  const { showAlert } = useAlertDialog();

  const shouldUseOrSimulateAppStoreProduct =
    shouldUseAppStoreProduct() || simulateAppStoreProduct;

  const onStartPurchase = async () => {
    if (!profile) return;
    setDisplayPasswordPrompt(false);

    // Purchase with the App Store.
    if (shouldUseOrSimulateAppStoreProduct) {
      try {
        setIsPurchasing(true);
        await purchaseAppStoreProduct(
          privateGameTemplateListingData.appStoreProductId
        );
      } finally {
        setIsPurchasing(false);
      }
      return;
    }

    // Purchase with web.
    try {
      setIsPurchasing(true);
      const checkoutUrl = await getStripeCheckoutUrl(getAuthorizationHeader, {
        productId: privateGameTemplateListingData.id,
        priceName: privateGameTemplateListingData.prices[0].name,
        userId: profile.id,
        customerEmail: profile.email,
        ...(password ? { password } : undefined),
      });
      Window.openExternalURL(checkoutUrl);
    } catch (error) {
      if (
        error.response &&
        error.response.status === 403 &&
        error.response.data.code === 'auth/wrong-password'
      ) {
        await showAlert({
          title: t`Operation not allowed`,
          message: t`The password you entered is incorrect. Please try again.`,
        });
      } else {
        console.error('Unable to get the checkout URL', error);
        await showAlert({
          title: t`An error happened`,
          message: t`Unable to get the checkout URL. Please try again later.`,
        });
      }
      setIsPurchasing(false);
    } finally {
      setPassword('');
    }
  };

  const onWillPurchase = () => {
    // Password is required in dev environment only so that one cannot freely purchase game templates.
    if (Window.isDev()) setDisplayPasswordPrompt(true);
    else onStartPurchase();
  };

  const checkUserPurchases = React.useCallback(
    async () => {
      if (!profile) return;
      try {
        const userPurchases = await listUserPurchases(getAuthorizationHeader, {
          userId: profile.id,
          productType: 'game-template',
          role: 'receiver',
        });
        if (
          userPurchases.find(
            userPurchase =>
              userPurchase.productId === privateGameTemplateListingData.id
          )
        ) {
          // We found the purchase, the user has bought the game template.
          // We do not close the dialog yet, as we need to trigger a refresh of the purchases.
          await onPurchaseSuccessful();
        }
      } catch (error) {
        console.error('Unable to get the user purchases', error);
        await showAlert({
          title: t`An error happened`,
          message: t`An error happened while checking if your purchase was successful. If you have completed the payment, close and re-open the store to see your game template!`,
        });
      }
    },
    [
      profile,
      getAuthorizationHeader,
      privateGameTemplateListingData,
      onPurchaseSuccessful,
      showAlert,
    ]
  );

  useInterval(
    () => {
      checkUserPurchases();
    },
    isPurchasing ? 3900 : null
  );

  // Listen to the received game template, to know when a user has just logged in and the received game templates have been loaded.
  // In this case, start a timeout to remove the loader and give some time for the store to refresh.
  React.useEffect(
    () => {
      let timeoutId;
      (async () => {
        if (receivedGameTemplates) {
          timeoutId = setTimeout(
            () => setIsCheckingPurchasesAfterLogin(false),
            3000
          );
        }
      })();
      return () => {
        clearTimeout(timeoutId);
      };
    },
    [receivedGameTemplates]
  );

  // If the user has received this particular template, either:
  // - they just logged in, and already have it, so we close the dialog.
  // - they just bought it, we display the success message.
  React.useEffect(
    () => {
      if (receivedGameTemplates) {
        const receivedGameTemplate = receivedGameTemplates.find(
          gameTemplate => gameTemplate.id === privateGameTemplateListingData.id
        );
        if (receivedGameTemplate) {
          if (isPurchasing) {
            setIsPurchasing(false);
            setPurchaseSuccessful(true);
          } else if (!purchaseSuccessful) {
            onClose();
          }
        }
      }
    },
    [
      receivedGameTemplates,
      privateGameTemplateListingData,
      isPurchasing,
      onClose,
      isCheckingPurchasesAfterLogin,
      purchaseSuccessful,
    ]
  );

  const dialogContents = !profile
    ? {
        subtitle: <Trans>Log-in to purchase this item</Trans>,
        content: (
          <CreateProfile
            onLogin={onLogin}
            onCreateAccount={onCreateAccount}
            message={
              <Trans>
                Game templates will be linked to your user account and available
                for all your projects. Log-in or sign-up to purchase this game
                template. (or restore your existing purchase).
              </Trans>
            }
            justifyContent="center"
          />
        ),
      }
    : purchaseSuccessful
    ? {
        subtitle: <Trans>Your purchase has been processed!</Trans>,
        content: (
          <Line justifyContent="center" alignItems="center">
            <Text>
              <Trans>
                You can now go back to the store to use your new game template.
              </Trans>
            </Text>
          </Line>
        ),
      }
    : isPurchasing
    ? {
        subtitle: shouldUseOrSimulateAppStoreProduct ? (
          <Trans>Complete your purchase with the app store.</Trans>
        ) : (
          <Trans>Complete your payment on the web browser</Trans>
        ),
        content: shouldUseOrSimulateAppStoreProduct ? (
          <>
            <ColumnStackLayout justifyContent="center" alignItems="center">
              <CircularProgress size={40} />
              <Text>
                <Trans>
                  The purchase will be linked to your account once done.
                </Trans>
              </Text>
            </ColumnStackLayout>
          </>
        ) : (
          <>
            <Line justifyContent="center" alignItems="center">
              <CircularProgress size={20} />
              <Spacer />
              <Text>
                <Trans>Waiting for the purchase confirmation...</Trans>
              </Text>
            </Line>
            <Spacer />
            <Line justifyContent="center">
              <BackgroundText>
                <Trans>
                  Once you're done, come back to GDevelop and the game template
                  will be added to your account automatically.
                </Trans>
              </BackgroundText>
            </Line>
          </>
        ),
      }
    : isCheckingPurchasesAfterLogin
    ? {
        subtitle: <Trans>Loading your profile...</Trans>,
        content: (
          <Line justifyContent="center" alignItems="center">
            <CircularProgress size={20} />
          </Line>
        ),
      }
    : {
        subtitle: (
          <Trans>
            The game template {privateGameTemplateListingData.name} will be
            linked to your account {profile.email}.
          </Trans>
        ),
        content: shouldUseOrSimulateAppStoreProduct ? null : (
          <Line justifyContent="center" alignItems="center">
            <Text>
              <Trans>
                A new secure window will open to complete the purchase.
              </Trans>
            </Text>
          </Line>
        ),
      };

  const allowPurchase =
    profile &&
    !isPurchasing &&
    !purchaseSuccessful &&
    !isCheckingPurchasesAfterLogin;
  const dialogActions = [
    <FlatButton
      key="cancel"
      label={purchaseSuccessful ? <Trans>Close</Trans> : <Trans>Cancel</Trans>}
      onClick={onClose}
    />,
    allowPurchase ? (
      <DialogPrimaryButton
        key="continue"
        primary
        label={<Trans>Continue</Trans>}
        onClick={onWillPurchase}
      />
    ) : null,
  ];

  return (
    <>
      <Dialog
        title={<Trans>{privateGameTemplateListingData.name}</Trans>}
        maxWidth="sm"
        open
        onRequestClose={onClose}
        actions={dialogActions}
        onApply={purchaseSuccessful ? onClose : onWillPurchase}
        cannotBeDismissed // Prevent the user from continuing by clicking outside.
        flexColumnBody
      >
        <LineStackLayout justifyContent="center" alignItems="center">
          {purchaseSuccessful && <Mark />}
          <Text size="sub-title">{dialogContents.subtitle}</Text>
        </LineStackLayout>
        {dialogContents.content}
      </Dialog>
      {displayPasswordPrompt && (
        <PasswordPromptDialog
          onApply={onStartPurchase}
          onClose={() => setDisplayPasswordPrompt(false)}
          passwordValue={password}
          setPasswordValue={setPassword}
        />
      )}
    </>
  );
};

export default PrivateGameTemplatePurchaseDialog;
