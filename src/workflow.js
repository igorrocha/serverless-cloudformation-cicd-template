import AWS from 'aws-sdk';
import {
  notify,
} from './utils';

const s3 = new AWS.S3({ apiVersion: '2006-03-01' });
const stepfunctions = new AWS.StepFunctions({ apiVersion: '2016-11-23' });

const getStackInfo = async ({ Location: location }) => {
  console.log("LOCATION", location);

  const bucketName = location.split('/')[0].split(':::')[1];
  const key = `${location.split('/').slice(1).join('/')}/serverless-state.json`;

  const {
    Body: file,
  } = await s3.getObject({
    Bucket: bucketName,
    Key: key,
  }).promise();

  const {
    service: {
      custom: {
        cicd: {
          syncS3BucketName,
          rdsIdentifier,
          hostedZoneId,
          rdsDomain,
        } = {},
      } = {},
      provider: {
        deploymentBucket,
        stackName,
      },
    },
    package: {
      artifactDirectoryName,
    }
  } = JSON.parse(file);

  return {
    stackName,
    deploymentBucket,
    artifactDirectoryName,
    syncS3BucketName: syncS3BucketName || false,
    rdsIdentifier: rdsIdentifier || false,
    hostedZoneId: hostedZoneId || false,
    rdsDomain: rdsDomain || false,
  }
}

export const mapPackagingVariables = async (event, context) => {
  console.log("EVENT", JSON.stringify(event));

  const [
    serverlessPackage,
    webpackPackage
  ] = event;

  const result = {
    qa: {},
    production: {},
  };

  if (serverlessPackage) {
    const {
      Build: {
        SecondaryArtifacts: serverlessSecondaryArtifacts,
      },
    } = serverlessPackage;

    result.qa.serverless = {};
    result.production.serverless = {};

    for (const artifact of serverlessSecondaryArtifacts) {
      console.log("ARTIFACT", artifact)
      switch (artifact.ArtifactIdentifier) {
        case process.env.serverlessQAArtifactName:
          result.qa.serverless.package = artifact;
          break;
        case process.env.serverlessQAStateName:
          result.qa.serverless.state = artifact;
          Object.assign(result.qa.serverless, await getStackInfo(artifact));
          break;
        case process.env.serverlessProductionArtifactName:
          result.production.serverless.package = artifact;
          break;
        case process.env.serverlessProductionStateName:
          result.production.serverless.state = artifact;
          Object.assign(result.production.serverless, await getStackInfo(artifact));
          break;
      }
    }
  }

  if (webpackPackage) {
    const {
      Build: {
        SecondaryArtifacts: webpackSecondaryArtifacts,
      },
    } = webpackPackage;

    for (const artifact of webpackSecondaryArtifacts) {
      switch (artifact.ArtifactIdentifier) {
        case process.env.webpackQAArtifactName:
          result.qa.webpack = artifact;
          break;
        case process.env.webpackProductionArtifactName:
          result.production.webpack = artifact;
          break;
      }
    }
  }

  return result;
}

const backupArtifact = async ({ location, name }) => {
  const extension = location.split('.').pop();
  const source = `/${location.replace('arn:aws:s3:::', '')}`;
  const key = `${name}.${extension}`;

  console.log("BUCKET", process.env.bucket);
  console.log("SOURCE", source);
  console.log("KEY", key);

  return s3.copyObject({
    Bucket: process.env.bucket,
    CopySource: source,
    Key: key,
  }).promise();
}

export const saveBackup = async (event, context) => {
  console.log("EVENT", event);

  const {
    Payload: {
      isServerless,
      isWebpack,
      packages,
    } = {},
  } = event;

  if (isServerless) {
    for (const t of ['state', 'package']) {
      for (const e of ['qa', 'production']) {
        let {
          Location: location,
        } = packages[e]['serverless'][t];

        if (t === 'state') {
          location = `${location}/serverless-state.json`;
        }

        await backupArtifact({ location, name: `serverless-${t}-${e}-backup` });
      }
    }
  }

  if (isWebpack) {
    for (const e of ['qa', 'production']) {
      let {
        Location: location,
      } = packages[e]['webpack'];

      await backupArtifact({ location, name: `webpack-package-${e}-backup` });
    }
  }
}

export const notifySuccess = async (event, context) => {
  const {
    Payload: {
      executionId,
      branchName,
    } = {},
  } = event;

  const executionURL = `https://console.aws.amazon.com/states/home?region=us-east-1#/executions/details/${executionId}`;

  return notify({
    title: `${process.env.bitbucketWorkspace}/${process.env.bitbucketRepository} - New version online!`,
    text: `The branch ${branchName} was merged and deployed to production.${executionId ? `\nThis CI/CD execution can be found at : ${executionURL}` : ''}`,
    status: 'success',
  });
}

export const notifiyError = async (event, context) => {
  const {
    Payload: {
      executionId,
      errorInfo: {
        Error: error,
      } = {},
    } = {},
  } = event;

  const executionURL = `https://console.aws.amazon.com/states/home?region=us-east-1#/executions/details/${executionId}`;

  if (error === 'PullRequestRejected') {
    return notify({
      title: `${process.env.bitbucketWorkspace}/${process.env.bitbucketRepository} - CI/CD Pull Request Rejected Rollback Complete`,
      text: `Pull Request was Rejected. ${executionId ? `\nThis CI/CD execution can be found at : ${executionURL}` : ''}`,
      status: 'error',
    });
  }

  return notify({
    title: `${process.env.bitbucketWorkspace}/${process.env.bitbucketRepository} - CI/CD ${error || 'Unexpected Error!'}`,
    text: `An error has ocurred.${executionId ? `\nThis CI/CD execution can be found at : ${executionURL}` : ''}`,
    status: 'error',
  });
}

export const notifyFailToSF = async (event, context) => {
  const {
    Payload: {
      errorInfo,
      taskToken,
    }
  } = event;

  await stepfunctions.sendTaskFailure({
    taskToken,
    error: errorInfo.errorType || errorInfo.Error,
    cause: errorInfo.errorMessage || errorInfo.Cause,
  }).promise();
}

export const notifySuccessToSF = async (event, context) => {
  const {
    Payload: {
      taskToken,
    }
  } = event;

  await stepfunctions.sendTaskSuccess({
    taskToken,
    output: JSON.stringify(event),
  }).promise();
}